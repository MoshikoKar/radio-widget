//! Local stream proxy on 127.0.0.1.
//!
//! The UI plays `http://127.0.0.1:<port>/stream?id=<n>&u=<stream url>`. We ask
//! the station for ICY metadata (`Icy-MetaData: 1`), strip the metadata blocks
//! out of the audio, and emit `StreamTitle` to the UI as a `metadata` event,
//! along with any explicit ad marker the station's ad server inserted.
//! The response carries CORS headers so the Web Audio visualizer can read it.

use crate::http;
use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Meta {
    id: String,
    title: Option<String>,
    /// the station explicitly flagged this block as an ad (AdsWizz `adw_ad`)
    ad: bool,
    /// announced ad length, when the ad server gives one
    ad_ms: Option<u64>,
}

/// Starts the proxy and returns its port.
pub fn start(app: AppHandle) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("proxy bind");
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // only one stream plays at a time: a new request ends the previous one
    let generation = Arc::new(AtomicU64::new(0));
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let app = app.clone();
            let gen = generation.clone();
            std::thread::spawn(move || {
                let _ = handle(conn, app, gen);
            });
        }
    });
    port
}

fn handle(mut client: TcpStream, app: AppHandle, gen: Arc<AtomicU64>) -> std::io::Result<()> {
    let mut reader = BufReader::new(client.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    // drain request headers
    let mut h = String::new();
    while reader.read_line(&mut h)? > 2 {
        h.clear();
    }
    let target = line.split_whitespace().nth(1).unwrap_or("/");
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok();
    let (path_ok, id, upstream) = match &url {
        Some(u) => {
            let q = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
            (u.path() == "/stream", q("id").unwrap_or_default(), q("u"))
        }
        None => (false, String::new(), None),
    };
    let Some(upstream) = upstream.filter(|_| path_ok) else {
        client.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    };

    let my_gen = gen.fetch_add(1, Ordering::SeqCst) + 1;
    let resp = match http::get(&upstream, &[("Icy-MetaData", "1")], Duration::from_secs(10)) {
        Ok(r) if r.status == 200 => r,
        Ok(r) => return bad_gateway(&mut client, &format!("upstream {}", r.status)),
        Err(e) => return bad_gateway(&mut client, &e.to_string()),
    };

    let metaint: usize = resp.header("icy-metaint").and_then(|v| v.parse().ok()).unwrap_or(0);
    let ctype = resp.header("content-type").unwrap_or("audio/mpeg").to_string();
    write!(
        client,
        "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
    )?;

    let send = |title: Option<String>, ad: bool, ad_ms: Option<u64>| {
        let _ = app.emit("metadata", Meta { id: id.clone(), title, ad, ad_ms });
    };
    if metaint == 0 {
        send(None, false, None);
    }

    let mut body = resp.body;
    let mut buf = vec![0u8; 16 * 1024];
    let mut out = Vec::with_capacity(16 * 1024);
    let mut remaining = metaint; // audio bytes until the next metadata block
    let mut meta_len = 0usize;
    let mut meta = Vec::new();
    enum St {
        Audio,
        Len,
        Meta,
    }
    let mut st = St::Audio;

    loop {
        if gen.load(Ordering::SeqCst) != my_gen {
            break; // a newer stream took over
        }
        let n = match body.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if metaint == 0 {
            if client.write_all(&buf[..n]).is_err() {
                break;
            }
            continue;
        }
        out.clear();
        let mut i = 0;
        while i < n {
            match st {
                St::Audio => {
                    let k = remaining.min(n - i);
                    out.extend_from_slice(&buf[i..i + k]);
                    remaining -= k;
                    i += k;
                    if remaining == 0 {
                        st = St::Len;
                    }
                }
                St::Len => {
                    meta_len = buf[i] as usize * 16;
                    i += 1;
                    if meta_len == 0 {
                        st = St::Audio;
                        remaining = metaint;
                    } else {
                        meta.clear();
                        st = St::Meta;
                    }
                }
                St::Meta => {
                    let k = meta_len.min(n - i);
                    meta.extend_from_slice(&buf[i..i + k]);
                    meta_len -= k;
                    i += k;
                    if meta_len == 0 {
                        let fields = parse_fields(&decode(&meta));
                        let (ad, ad_ms) = ad_marker(&fields);
                        let title = field(&fields, "StreamTitle").map(|t| t.trim().to_string());
                        if title.is_some() || ad {
                            send(title, ad, ad_ms);
                        }
                        st = St::Audio;
                        remaining = metaint;
                    }
                }
            }
        }
        if !out.is_empty() && client.write_all(&out).is_err() {
            break;
        }
    }
    Ok(())
}

fn bad_gateway(client: &mut TcpStream, msg: &str) -> std::io::Result<()> {
    write!(
        client,
        "HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{msg}",
        msg.len()
    )
}

/// UTF-8 first; Hebrew stations often send windows-1255.
fn decode(raw: &[u8]) -> String {
    let end = raw.iter().rposition(|&b| b != 0).map_or(0, |p| p + 1);
    let raw = &raw[..end];
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1255.decode(raw).0.into_owned(),
    }
}

/// ICY metadata is `Key='value';Key2='value2';`. Values may contain quotes
/// (`Don't Stop`), so a value only ends at `';` followed by the next key or the end.
fn parse_fields(meta: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = meta;
    while let Some(eq) = rest.find("='") {
        let key = rest[..eq].trim_matches(|c: char| c == ';' || c.is_whitespace()).to_string();
        let after = &rest[eq + 2..];
        let mut end = after.len();
        let mut from = 0;
        while let Some(p) = after[from..].find("';") {
            let at = from + p;
            let next = &after[at + 2..];
            let next_is_key = next.trim().is_empty()
                || next.find("='").is_some_and(|k| next[..k].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
            if next_is_key {
                end = at;
                break;
            }
            from = at + 2;
        }
        let value = after[..end].trim_end_matches('\'').to_string();
        out.push((key, value));
        rest = after.get(end + 2..).unwrap_or("");
    }
    out
}

fn field<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
    fields.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}

/// Explicit ad markers only — never guessed from the audio or from a missing title.
/// AdsWizz-served streams send `adw_ad='true'` (sometimes inside StreamUrl's
/// query string) together with `durationMilliseconds`.
fn ad_marker(fields: &[(String, String)]) -> (bool, Option<u64>) {
    let truthy = |v: &str| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes");
    let mut ad = field(fields, "adw_ad").is_some_and(truthy);
    let mut ms = field(fields, "durationMilliseconds").and_then(|v| v.trim().parse().ok());
    if let Some(u) = field(fields, "StreamUrl") {
        if let Ok(parsed) = url::Url::parse(u) {
            for (k, v) in parsed.query_pairs() {
                if k.eq_ignore_ascii_case("adw_ad") && truthy(&v) {
                    ad = true;
                }
                if k.eq_ignore_ascii_case("durationMilliseconds") && ms.is_none() {
                    ms = v.trim().parse().ok();
                }
            }
        }
    }
    (ad, if ad { ms.filter(|&m| m > 0 && m < 10 * 60 * 1000) } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_titles_with_quotes() {
        let f = parse_fields("StreamTitle='Toto - Don't Stop';StreamUrl='';");
        assert_eq!(field(&f, "StreamTitle"), Some("Toto - Don't Stop"));
        assert_eq!(field(&f, "StreamUrl"), Some(""));
    }

    #[test]
    fn detects_adswizz_fields() {
        let f = parse_fields("StreamTitle='';StreamUrl='';adw_ad='true';durationMilliseconds='30040';adId='123';insertionType='midroll';");
        assert_eq!(ad_marker(&f), (true, Some(30040)));
    }

    #[test]
    fn detects_adswizz_in_stream_url() {
        let f = parse_fields("StreamTitle='Brand';StreamUrl='http://x.example/a?adw_ad=true&durationMilliseconds=15000';");
        assert_eq!(ad_marker(&f), (true, Some(15000)));
    }

    #[test]
    fn plain_song_is_not_an_ad() {
        let f = parse_fields("StreamTitle='Robbie Williams - Advertising Space';");
        assert_eq!(ad_marker(&f), (false, None));
        let f = parse_fields("StreamTitle='x';adw_ad='false';");
        assert_eq!(ad_marker(&f).0, false);
    }
}
