# Firefox development build

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
uses Manifest V2 in Firefox; it does not add Chrome Manifest V3 support.
