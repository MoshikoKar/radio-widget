//! Local stream proxy on 127.0.0.1.
//!
//! The UI plays `http://127.0.0.1:<port>/stream?id=<n>&u=<stream url>`. We ask
//! the station for ICY metadata (`Icy-MetaData: 1`), strip the metadata blocks
//! out of the audio, and emit `StreamTitle` to the UI as a `metadata` event.
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

    let send = |title: Option<String>| {
        let _ = app.emit("metadata", Meta { id: id.clone(), title });
    };
    if metaint == 0 {
        send(None);
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
                        if let Some(t) = stream_title(&decode(&meta)) {
                            send(Some(t));
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

fn stream_title(meta: &str) -> Option<String> {
    let start = meta.find("StreamTitle='")? + "StreamTitle='".len();
    let rest = &meta[start..];
    let end = rest.find("';").unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}
