# Phase 5 field report

Generated: 2026-02-19T03:01:42.620Z

## Corpus
- pages: 10
- css payload records: 419
- css by kind: {"linked":38,"style-attr":356,"inline-style":25}

## Timing distribution
- parse p50 ms: 17.18
- parse p95 ms: 95.706
- render p50 ms: 3.754
- render p95 ms: 15.582

## Worst pages by parse time
- c3a6d9674d9825d6be99d1cb57a22189705857a6ad6bc02c87112111800f70a7 (parseTimeMs=111.009) https://en.wikipedia.org/wiki/HTML
- 47e943a744d3a61463b3cfea5d149237e2c04cce014aeeb8550a94f433cf31b1 (parseTimeMs=95.706) https://developer.mozilla.org/en-US/docs/Web/HTML
- 8ee7a82086122e9468429f1ab610a35203686b4edc2f0eed171ea34d94e0069d (parseTimeMs=64.165) https://nodejs.org/en
- 51a52ac06241ad2b1fabe077a5216705b760044d272bdb381011a84260beee61 (parseTimeMs=26.613) https://www.rfc-editor.org/
- 9a024cc07b452c8bdac48b1319cac868d10a4d7904e3e28854e4fd1ddf53d6db (parseTimeMs=18.276) https://www.gnu.org/
- 3f324f9914742e62cf082861ba03b207282dba781c3349bee9d7c1b5ef8e0bfe (parseTimeMs=17.18) https://httpbin.org/html
- 7789d1f028a924bc039f43a18c4058f4bed67ff689cea9e2909219706799b399 (parseTimeMs=11.211) https://www.w3.org/
- feea237652a329a56679107f313817ce42d5564d93f86d20bb3eba0b12899061 (parseTimeMs=8.26) https://www.python.org/
- a59a9a8f6d6eba16e6c30046510e37f3b346a6b53f11f1113f45e1abc4f3ee00 (parseTimeMs=2.438) http://www.iana.org/help/example-domains
- fb91d75a6bb430787a61b0aec5e374f580030f2878e1613eab5ca6310f7bbb9a (parseTimeMs=0.363) http://example.org/

## Worst pages by render time
- c3a6d9674d9825d6be99d1cb57a22189705857a6ad6bc02c87112111800f70a7 (renderTimeMs=72.138) https://en.wikipedia.org/wiki/HTML
- 47e943a744d3a61463b3cfea5d149237e2c04cce014aeeb8550a94f433cf31b1 (renderTimeMs=15.582) https://developer.mozilla.org/en-US/docs/Web/HTML
- feea237652a329a56679107f313817ce42d5564d93f86d20bb3eba0b12899061 (renderTimeMs=5.937) https://www.python.org/
- 9a024cc07b452c8bdac48b1319cac868d10a4d7904e3e28854e4fd1ddf53d6db (renderTimeMs=5.561) https://www.gnu.org/
- 7789d1f028a924bc039f43a18c4058f4bed67ff689cea9e2909219706799b399 (renderTimeMs=5.123) https://www.w3.org/
- 8ee7a82086122e9468429f1ab610a35203686b4edc2f0eed171ea34d94e0069d (renderTimeMs=3.754) https://nodejs.org/en
- 51a52ac06241ad2b1fabe077a5216705b760044d272bdb381011a84260beee61 (renderTimeMs=2.632) https://www.rfc-editor.org/
- 3f324f9914742e62cf082861ba03b207282dba781c3349bee9d7c1b5ef8e0bfe (renderTimeMs=2.277) https://httpbin.org/html
- a59a9a8f6d6eba16e6c30046510e37f3b346a6b53f11f1113f45e1abc4f3ee00 (renderTimeMs=1.21) http://www.iana.org/help/example-domains
- fb91d75a6bb430787a61b0aec5e374f580030f2878e1613eab5ca6310f7bbb9a (renderTimeMs=0.186) http://example.org/

## Parse error frequencies
- none

## Oracle availability and fingerprints
- source mode: image
- image fingerprint: 652091a853b227c75e1c966ce4033ab5358089f4b6ff23468282946efd1100dc
- image package count: 101
- lynx (image): sha256=a598456aa5c8122453f7074c66233800a4032bf14b1171bccde98f83810ebf9d version=Lynx Version 2.9.2 (31 May 2024)
libwww-FM 2.14, SSL-MM 1.4.1, GNUTLS 3.8.5, ncurses 6.5.20250216(wide)
Built on linux-gnu.

Copyrights held by the Lynx Developers Group,
the University of Kansas, CERN, and other contributors.
Distributed under the GNU General Public License (Version 2).
See https://lynx.invisible-island.net/ and the online help for more information.
- w3m (image): sha256=cac51dee53b02dcc67746e549e3981f61f4192a80befeaec5e2172307f1e9567 version=w3m version w3m/0.5.3+git20230121, options lang=en,m17n,image,color,ansi-color,mouse,gpm,menu,cookie,ssl,ssl-verify,external-uri-loader,w3mmailer,nntp,gopher,ipv6,alarm,mark,migemo
- links2 (image): sha256=dc742a769d9b6bea15ae4712a30f5d03356c9f4a4fc396ed1ef02ce4462a90cc version=Links 2.29

## Worst oracle disagreements
- links2: meanTokenF1=0.955391
  worst: 7789d1f028a924bc039f43a18c4058f4bed67ff689cea9e2909219706799b399 width=80 tokenF1=0.835498
- lynx: meanTokenF1=0.971912
  worst: 8ee7a82086122e9468429f1ab610a35203686b4edc2f0eed171ea34d94e0069d width=80 tokenF1=0.896
- w3m: meanTokenF1=0.985821
  worst: 47e943a744d3a61463b3cfea5d149237e2c04cce014aeeb8550a94f433cf31b1 width=80 tokenF1=0.92529

## Parity checks
- parseBytes vs parseStream mismatches: 0
