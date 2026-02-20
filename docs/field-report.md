# Field report

Generated: 2026-02-20T00:44:35.760Z

## Corpus
- pages: 102
- css payload records: 11251
- css by kind: {"linked":513,"style-attr":10265,"inline-style":473}

## Timing distribution
- parse p50 ms: 33.53
- parse p95 ms: 228.813
- render p50 ms: 8.039
- render p95 ms: 66.571

## Worst pages by parse time
- 74ac228397b20808860315ba7e8d4b7b52a69ff46ccc4a9f079998746f086da5 (parseTimeMs=393.008) https://fetch.spec.whatwg.org/
- 2fac45d1ade51c54e5acbc986dc82d1918b5bf7a7e2544c9aea1fdec7022b706 (parseTimeMs=353.384) https://www.rfc-editor.org/rfc/rfc9110
- 05aa64853c4428146973943b35caf121e44c1076bdf5b8c29f8896dba9b778e2 (parseTimeMs=337.531) https://www.w3.org/TR/css-grid-2/
- b0e3b097bc6db0688d4712968c290cda280f8f750eb998bc358c28df490ff3f5 (parseTimeMs=282.035) https://www.w3.org/TR/css-flexbox-1/
- 557f48bce4a5a9b84860d0ba8435c3ab928d2610e63f5229e3e08fa9b59a649f (parseTimeMs=264.71) https://www.w3.org/TR/css-fonts-4/
- 32f416053f48bdd1a11f83325323bed05ad40243d9534c5fbb2bf55f18f98a26 (parseTimeMs=242.848) https://www.w3.org/TR/css-color-4/
- 26deff18a5cff0e933eda56a71aeb2f1fa99683defdbf89e6ffc2242ea5b2dc0 (parseTimeMs=228.813) https://bun.sh/docs/runtime/http/server
- 5d3b3f7e1fcc562dcec1a01ad2c5651e9f0bac294b255a75352e9df202604e6d (parseTimeMs=192.629) https://www.w3.org/TR/selectors-4/
- 17ea376e45886536bd59dbc69ea2d93cc3c5f1744da985899f329133303d5c52 (parseTimeMs=190.66) https://bun.sh/docs/runtime/shell
- 59f107062bee1844e43f41ec3c93d447fc0367a3d113e4a2876f8eedb690a937 (parseTimeMs=162.003) https://workers.cloudflare.com/

## Worst pages by render time
- 2fac45d1ade51c54e5acbc986dc82d1918b5bf7a7e2544c9aea1fdec7022b706 (renderTimeMs=151.063) https://www.rfc-editor.org/rfc/rfc9110
- 74ac228397b20808860315ba7e8d4b7b52a69ff46ccc4a9f079998746f086da5 (renderTimeMs=124.895) https://fetch.spec.whatwg.org/
- b0e3b097bc6db0688d4712968c290cda280f8f750eb998bc358c28df490ff3f5 (renderTimeMs=105.242) https://www.w3.org/TR/css-flexbox-1/
- 557f48bce4a5a9b84860d0ba8435c3ab928d2610e63f5229e3e08fa9b59a649f (renderTimeMs=104.609) https://www.w3.org/TR/css-fonts-4/
- 05aa64853c4428146973943b35caf121e44c1076bdf5b8c29f8896dba9b778e2 (renderTimeMs=82.005) https://www.w3.org/TR/css-grid-2/
- 32f416053f48bdd1a11f83325323bed05ad40243d9534c5fbb2bf55f18f98a26 (renderTimeMs=74.741) https://www.w3.org/TR/css-color-4/
- 5d3b3f7e1fcc562dcec1a01ad2c5651e9f0bac294b255a75352e9df202604e6d (renderTimeMs=66.571) https://www.w3.org/TR/selectors-4/
- 2b5c038befc0d3ab2d619143fe6c474dd75a7f2573a365d847c8a4894340a20b (renderTimeMs=66.363) https://url.spec.whatwg.org/
- 1fe27cdb69e4990a801bdad630d4bea755b4d472ff9aa23bf07f743056a3a2a1 (renderTimeMs=62.846) https://www.w3.org/TR/css-cascade-5/
- 413b27acb4e16721d28b487456359ecbcecba472c4310bd2f6a4939ad393738b (renderTimeMs=60.836) https://www.w3.org/TR/css-syntax-3/

## Parse error frequencies
- control-character-in-input-stream: 51
- unexpected-question-mark-instead-of-tag-name: 50
- duplicate-attribute: 6
- missing-doctype: 5
- non-void-html-element-start-tag-with-trailing-solidus: 3
- non-conforming-doctype: 2
- end-tag-without-matching-open-element: 1

## Oracle availability and fingerprints
- source mode: image
- image fingerprint: b4cc7fafb433f0ad069cffdd1e73859a63ac60700ac06cbf4bd7fa129b846ac7
- image package count: 101
- normalization version: v1
- normalization mode: side-by-side
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
- links2: meanRawTokenF1=0.960218 meanNormalizedTokenF1=0.967322
  worst raw: e427ac1791eeab4568589fc73ef8fb3971092c92a1f96bee20f68d4b0c6d9841 width=80 rawTokenF1=0 normalizedTokenF1=0
  worst normalized: e427ac1791eeab4568589fc73ef8fb3971092c92a1f96bee20f68d4b0c6d9841 width=80 rawTokenF1=0 normalizedTokenF1=0
- lynx: meanRawTokenF1=0.937337 meanNormalizedTokenF1=0.940985
  worst raw: e427ac1791eeab4568589fc73ef8fb3971092c92a1f96bee20f68d4b0c6d9841 width=80 rawTokenF1=0 normalizedTokenF1=0
  worst normalized: e427ac1791eeab4568589fc73ef8fb3971092c92a1f96bee20f68d4b0c6d9841 width=80 rawTokenF1=0 normalizedTokenF1=0
- w3m: meanRawTokenF1=0.956068 meanNormalizedTokenF1=0.956068
  worst raw: e427ac1791eeab4568589fc73ef8fb3971092c92a1f96bee20f68d4b0c6d9841 width=80 rawTokenF1=0 normalizedTokenF1=0
  worst normalized: e427ac1791eeab4568589fc73ef8fb3971092c92a1f96bee20f68d4b0c6d9841 width=80 rawTokenF1=0 normalizedTokenF1=0

## Oracle scores by page surface
- page surfaces: {"meaningful-content":88,"challenge-shell":13,"redirect-shell":1}
- challenge-shell: pages=13
  links2: meanRawTokenF1=0.99363 meanNormalizedTokenF1=0.994111
  lynx: meanRawTokenF1=0.841151 meanNormalizedTokenF1=0.841894
  w3m: meanRawTokenF1=0.933545 meanNormalizedTokenF1=0.933545
- meaningful-content: pages=88
  links2: meanRawTokenF1=0.966193 meanNormalizedTokenF1=0.974357
  lynx: meanRawTokenF1=0.962198 meanNormalizedTokenF1=0.966316
  w3m: meanRawTokenF1=0.970259 meanNormalizedTokenF1=0.970259
- redirect-shell: pages=1
  links2: meanRawTokenF1=0 meanNormalizedTokenF1=0
  lynx: meanRawTokenF1=0 meanNormalizedTokenF1=0
  w3m: meanRawTokenF1=0 meanNormalizedTokenF1=0

## Parity checks
- parseBytes vs parseStream mismatches: 0
