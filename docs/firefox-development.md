# Firefox development build

On `mv3-codex`, this is an experimental MV3 build. Read
[the assessment and validation gates](mv3-assessment.md) before installing it.
Use `npm run webpack:firefox -- --mode=development --env outputRoot=/tmp/xbs-mv3-build`
to keep an existing installation's files intact. The MV2 recovery instructions
below describe `master`; the temporary-loading and reload steps also apply to MV3.

1. Run `npm ci`, then `npm run build:firefox:dev`.
2. Open `about:debugging#/runtime/this-firefox` in Firefox Developer Edition.
3. Use **Load Temporary Add-on** and select `build/firefox/manifest.json`.
4. After every rebuild, use **Reload** on the xBrowserSync extension card.
   The build replaces files on disk; an already loaded extension must be reloaded.

If clicking the toolbar icon does nothing, reload the extension first. During
diagnosis, reloading restored the background connection and popup. The initial
background failure's cause was not established. A development build also used
to request a missing `vendor.js`; only production builds generate that bundle.
Unknown runtime errors now preserve their original message rather than failing
while reconstructing a custom error.

To restore an existing sync, choose **Switch service**, enter the service URL,
then choose **Already got a sync ID?**. Enter the existing ID and encryption
password. This replaces local bookmarks with the server copy. Before proceeding,
use Firefox's Library → **Import and Backup → Backup**. That JSON can be restored
with **Restore → Choose File** in the same menu.

Temporary add-ons must be loaded again after Firefox restarts. This workflow
uses Manifest V2 in Firefox on `master`. The `mv3-codex` branch builds MV3 for
both browsers but has not passed the production validation gates.
