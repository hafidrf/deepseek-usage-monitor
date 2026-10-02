// The version of the code that is actually executing.
//
// Why this exists as a constant instead of reading the manifest at runtime:
// `vscode.extensions.getExtension(id).packageJSON.version` reports the version
// currently registered on disk, which is NOT necessarily the version whose
// JavaScript is loaded in the running extension host. After installing a new
// build while a window stays open, the two can disagree: the tooltip then
// claims the new version while rendering the old code, which is exactly the
// kind of mismatch that is impossible to diagnose from the UI.
//
// `npm run selfcheck` asserts that this matches package.json, so the two cannot
// drift apart unnoticed.
export const CODE_VERSION = '1.0.1';
