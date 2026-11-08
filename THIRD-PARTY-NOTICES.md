# Third-party notices

Radio Widget is MIT licensed (see [LICENSE](LICENSE)). It includes or links the following open-source components. All of them are under OSI-approved licenses, and none are modified.

## flag-icons

The country flag SVGs in `src/flags/` come from [flag-icons](https://github.com/lipis/flag-icons).

```
The MIT License (MIT)

Copyright (c) 2013 Panayiotis Lipiridis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Rust crates

The app is built with [Tauri](https://tauri.app) and other Rust crates, listed with exact versions in [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock). Their licenses, as declared by each crate:

| Licenses | Examples |
|---|---|
| MIT and/or Apache-2.0 (most crates) | tauri, tao, wry, serde, windows |
| Unicode-3.0 | icu_*, unicode-ident |
| BSD-3-Clause (some dual MIT/Apache-2.0) | brotli, encoding_rs |
| Zlib (some dual MIT/Apache-2.0) | zlib-rs, foldhash, miniz_oxide |
| MPL-2.0, used unmodified | cssparser, dtoa-short, option-ext |
| Unlicense OR MIT, CC0-1.0, 0BSD (with MIT/Apache-2.0 options) | memchr, walkdir, dunce, adler2 |

Each crate's full license text is in its source package on [crates.io](https://crates.io). To list them all: `cargo metadata --format-version 1` in `src-tauri/`.

## Runtime services and system components

- Station directory: [radio-browser.info](https://www.radio-browser.info) (public API, contacted at runtime; no code included).
- Microsoft Edge WebView2 Runtime: part of Windows, or downloaded by the installer from Microsoft. Not redistributed in this repository.
