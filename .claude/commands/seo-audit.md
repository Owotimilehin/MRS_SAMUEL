---
description: Audit the built site for SEO problems without changing anything
---
Build the storefront (`apps/customer`), start it (`PORT=3917 PUBLIC_API_URL=https://api.mrssamuel.com node .output/server/index.mjs`; read-only public endpoints), fetch every URL in its `/sitemap.xml` from that local server, and inspect the HTML. Report, as a table, any page that has:

- a missing, duplicate or over-60-character `<title>`
- a missing, duplicate or over-155-character meta description
- zero or more than one H1
- a canonical that is missing or not `https://mrssamuel.com/<its own path>`
- an `href` containing `$`, `www.mrssamuel.com` or `http://`
- fewer than 300 words of body text (product and area pages) or 1,000 (blog posts)
- no JSON-LD schema
- an image without width/height or alt text

Also check that every path in `apps/customer/src/lib/redirects.json` returns one 301 from the local server, and that the generated sitemap contains no redirected or missing URL.

Do not edit files. End with the three highest-impact fixes, mapped to task ids in `seo/roadmap.json` where they fit.
