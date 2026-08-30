/**
 * Curated terminal user-agent stylesheet derived from the HTML Standard's
 * rendering defaults and CSS Display mappings. Rules are CSS so HTML semantics
 * do not leak into box generation.
 */
export const USER_AGENT_STYLESHEET = String.raw`
@namespace html url(http://www.w3.org/1999/xhtml);
@namespace svg url(http://www.w3.org/2000/svg);
@namespace math url(http://www.w3.org/1998/Math/MathML);

html|html, html|body, html|address, html|article, html|aside, html|blockquote,
html|center, html|dd, html|details, html|dialog, html|div, html|dl, html|dt,
html|fieldset, html|figcaption,
html|figure, html|footer, html|form, html|h1, html|h2, html|h3, html|h4,
html|h5, html|h6, html|header, html|hgroup, html|hr, html|main, html|nav,
html|menu, html|ol, html|p, html|plaintext, html|pre, html|search,
html|section, html|summary, html|ul, html|xmp, html|listing {
  display: block;
}

html|head, html|base, html|basefont, html|bgsound, html|datalist, html|link,
html|meta, html|noembed, html|noframes, html|param, html|rp, html|script,
html|source, html|style, html|template, html|title, html|track,
html|input[type=hidden], html|area:not([href]) {
  display: none;
}

html|dialog:not([open]), html|details:not([open]) > :not(html|summary) {
  display: none;
}

[hidden] { display: none !important; }

[dir=ltr] { direction: ltr; }
[dir=rtl] { direction: rtl; }
html|bdi, [dir=auto] { unicode-bidi: isolate; }
html|bdo[dir=ltr] { direction: ltr; unicode-bidi: bidi-override; }
html|bdo[dir=rtl] { direction: rtl; unicode-bidi: bidi-override; }
html|input[dir=auto], html|textarea[dir=auto], html|pre[dir=auto] { unicode-bidi: plaintext; }

html|a:any-link:focus-visible, html|summary:focus-visible {
  font-weight: bold;
  text-decoration-line: underline;
}

html|li { display: list-item; }
html|summary { display: list-item; }
html|ol { list-style-type: decimal; }
html|ul { list-style-type: disc; }

html|table { display: table; }
html|caption { display: table-caption; }
html|colgroup { display: table-column-group; }
html|col { display: table-column; }
html|thead { display: table-header-group; }
html|tbody { display: table-row-group; }
html|tfoot { display: table-footer-group; }
html|tr { display: table-row; }
html|td, html|th { display: table-cell; padding: 1px; }

html|button, html|input, html|select, html|textarea {
  display: inline-block;
  white-space: pre;
}

html|img, html|audio, html|video, html|iframe, html|embed, html|object,
svg|svg, math|math { display: inline-block; }

html|br { display: inline; }
html|hr { border-style: solid; border-width: 1px; }

html|b, html|strong, html|h1, html|h2, html|h3, html|h4, html|h5,
html|h6, html|th { font-weight: 700; }
html|address, html|cite, html|em, html|i { font-style: italic; }
html|u { text-decoration-line: underline; }
html|del, html|s, html|strike { text-decoration-line: line-through; }
html|pre, html|xmp, html|plaintext, html|listing { white-space: pre; }
html|a[href], html|area[href] { text-decoration-line: underline; }

html|blockquote, html|figure { margin-block: 1em; margin-inline: 2em; }
html|p, html|dl, html|menu, html|ol, html|ul, html|pre { margin-block: 1em; }
html|dd { margin-inline-start: 2em; }
html|h1 { margin-block: .67em; }
html|h2 { margin-block: .83em; }
html|h3 { margin-block: 1em; }
html|h4 { margin-block: 1.33em; }
html|h5 { margin-block: 1.67em; }
html|h6 { margin-block: 2.33em; }
html|menu, html|ol, html|ul { padding-inline-start: 2em; }
`;

export const USER_AGENT_STYLESHEET_SOURCE = "verge:user-agent";
