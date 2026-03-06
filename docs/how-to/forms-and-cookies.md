# Work With Forms And Cookies

Goal: extract forms and build deterministic cookie headers.

```ts
import { cookieHeaderForUrl, extractForms, parseHtml, parseSetCookie } from "@ismail-elkorchi/verge-browser";

const tree = parseHtml("<form action='/submit'><input name='q'/></form>");
const forms = extractForms(tree, "https://example.com");

const cookie = parseSetCookie("sid=abc; Path=/; HttpOnly", "https://example.com");
const header = cookie ? cookieHeaderForUrl([cookie], "https://example.com") : "";

console.log(forms.length, header.includes("sid="));
```

Expected output:
- Deterministic form extraction and request cookie header assembly.
