# web/

Static skeleton for the Yooperlang website and language reference.
No build step, no frameworks, no CDN dependencies - just HTML, CSS, and a
small vanilla-JS syntax highlighter for `.yoop` code blocks.

## Files

- `index.html` - landing page (hero, code sample, link to the reference)
- `reference.html` - language reference skeleton with sidebar nav
- `styles.css` - shared styles
- `highlight.js` - tiny `.yoop` syntax highlighter (applied to `<pre><code class="yoop">`)

## Run locally

Any static file server works. From the repo root:

```bash
# Python 3
python3 -m http.server -d web 8080

# Or Node (no install)
npx --yes serve web -l 8080
```

Then open <http://localhost:8080/>.
