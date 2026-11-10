//! Minimal blocking HTTP/1.1 GET client.
//!
//! Hand-rolled on purpose: internet-radio servers often answer with a
//! non-standard `ICY 200 OK` status line (SHOUTcast v1), which regular HTTP
//! clients reject. It also keeps the binary small (TLS via Windows SChannel).

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use url::Url;

pub struct Response {
    pub status: u16,
    headers: Vec<(String, String)>,
    pub body: Box<dyn Read + Send>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

fn err(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::Other, msg.into())
}

fn connect(url: &Url, timeout: Duration, verify_tls: bool) -> io::Result<Box<dyn Stream>> {
    let host = url.host_str().ok_or_else(|| err("no host"))?;
    let port = url.port_or_known_default().ok_or_else(|| err("no port"))?;
    let mut last = err("could not resolve host");
    for addr in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(tcp) => {
                tcp.set_read_timeout(Some(timeout))?;
                tcp.set_write_timeout(Some(timeout))?;
                tcp.set_nodelay(true).ok();
                if url.scheme() == "https" {
                    let tls = native_tls::TlsConnector::builder()
                        .danger_accept_invalid_certs(!verify_tls)
                        .danger_accept_invalid_hostnames(!verify_tls)
                        .build()
                        .map_err(|e| err(e.to_string()))?;
                    let s = tls.connect(host, tcp).map_err(|e| err(e.to_string()))?;
                    return Ok(Box::new(s));
                }
                return Ok(Box::new(tcp));
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// GET `url`, following up to 5 redirects. `extra` headers are sent as-is.
/// `verify_tls` checks the server's certificate: on for the station directory,
/// off for streams, whose hosts often have broken or mismatched certificates.
pub fn get(url: &str, extra: &[(&str, &str)], timeout: Duration, verify_tls: bool) -> io::Result<Response> {
    let mut url = Url::parse(url).map_err(|e| err(e.to_string()))?;
    for _ in 0..6 {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(err("unsupported scheme"));
        }
        let mut stream = connect(&url, timeout, verify_tls)?;
        let host = url.host_str().unwrap_or_default();
        let host_hdr = match url.port() {
            Some(p) => format!("{host}:{p}"),
            None => host.to_string(),
        };
        let mut path = url.path().to_string();
        if let Some(q) = url.query() {
            path.push('?');
            path.push_str(q);
        }
        let mut req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host_hdr}\r\nUser-Agent: RadioWidget/0.5\r\nAccept: */*\r\nConnection: close\r\n"
        );
        for (k, v) in extra {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes())?;
        stream.flush()?;

        let mut reader = BufReader::with_capacity(16 * 1024, stream);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        // "HTTP/1.1 200 OK" or "ICY 200 OK"
        let status: u16 = line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| err(format!("bad status line: {}", line.trim())))?;
        let mut headers = Vec::new();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some((k, v)) = l.split_once(':') {
                headers.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        let find = |n: &str| {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(n))
                .map(|(_, v)| v.clone())
        };

        if (300..400).contains(&status) {
            if let Some(loc) = find("location") {
                url = url.join(&loc).map_err(|e| err(e.to_string()))?;
                continue;
            }
        }

        let chunked = find("transfer-encoding").map_or(false, |v| v.to_ascii_lowercase().contains("chunked"));
        let body: Box<dyn Read + Send> = if chunked {
            Box::new(Chunked { inner: reader, left: 0, done: false })
        } else if let Some(n) = find("content-length").and_then(|v| v.parse::<u64>().ok()) {
            Box::new(reader.take(n))
        } else {
            Box::new(reader)
        };
        return Ok(Response { status, headers, body });
    }
    Err(err("too many redirects"))
}

/// Decoder for `Transfer-Encoding: chunked` bodies.
struct Chunked<R: BufRead> {
    inner: R,
    left: usize,
    done: bool,
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut line = String::new();
            // skip the CRLF that ends the previous chunk
            while line.trim().is_empty() {
                line.clear();
                if self.inner.read_line(&mut line)? == 0 {
                    self.done = true;
                    return Ok(0);
                }
            }
            let size = line.trim().split(';').next().unwrap_or("0");
            self.left = usize::from_str_radix(size, 16).map_err(|_| err("bad chunk size"))?;
            if self.left == 0 {
                self.done = true;
                return Ok(0);
            }
        }
        let n = buf.len().min(self.left);
        let got = self.inner.read(&mut buf[..n])?;
        if got == 0 {
            self.done = true;
        }
        self.left -= got;
        Ok(got)
    }
}
