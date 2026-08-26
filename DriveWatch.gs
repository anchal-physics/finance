/**
 * DriveWatch.gs
 * ----------------------------------------------------------------------
 * Polls the shared Google Drive folder of brokerage transaction CSVs and, when
 * its contents change (a new/updated/removed file), triggers the GitHub Actions
 * workflow `update-holdings.yml` via a repository_dispatch — which merges the
 * CSVs into the Portfolio_* ledgers and recomputes the effective holdings.
 *
 * Runs as Anchal (installable time trigger), using his own Drive access — the
 * folder just needs to be visible to him (it is; he owns it). No service
 * account here (that's only for the Python side).
 *
 * ONE-TIME SETUP (see DRIVE_TRIGGER_SETUP.md):
 *   1. Create a fine-grained GitHub PAT scoped to the `finance` repo with
 *      "Contents: Read and write" (required to POST repository_dispatch).
 *   2. In the Apps Script editor → Project Settings → Script Properties, set:
 *        DRIVE_FOLDER_ID  = the shared folder id
 *        GITHUB_PAT       = the token from step 1
 *        GITHUB_REPO      = anchal-physics/finance   (optional; this is the default)
 *        DISPATCH_EVENT   = new-transactions          (optional; this is the default)
 *      (Or run setDriveWatchConfig(folderId, pat) once from the editor.)
 *   3. Run installDriveWatchTrigger() once (authorises Drive + external requests,
 *      seeds the baseline snapshot, and creates the 12-hour backstop poll).
 * The open web app also polls this folder every ~30 s (pollDriveChanges), so the
 * time trigger is just a backstop for when the app is closed.
 * Stop it with removeDriveWatchTrigger().
 * ----------------------------------------------------------------------
 */

var DW_PROPS = PropertiesService.getScriptProperties();

function dwConfig_() {
  return {
    folderId: DW_PROPS.getProperty('DRIVE_FOLDER_ID'),
    pat: DW_PROPS.getProperty('GITHUB_PAT'),
    repo: DW_PROPS.getProperty('GITHUB_REPO') || 'anchal-physics/finance',
    eventType: DW_PROPS.getProperty('DISPATCH_EVENT') || 'new-transactions'
  };
}

/** Convenience one-time setter (so you don't have to touch each property by hand). */
function setDriveWatchConfig(folderId, pat, repo) {
  if (folderId) DW_PROPS.setProperty('DRIVE_FOLDER_ID', folderId);
  if (pat) DW_PROPS.setProperty('GITHUB_PAT', pat);
  if (repo) DW_PROPS.setProperty('GITHUB_REPO', repo);
  DW_PROPS.deleteProperty('DRIVE_SNAPSHOT');   // force a fresh baseline next poll
}

/** Build a stable signature of the folder's CSV contents (id + mtime + size). */
function dwFolderSignature_(folderId) {
  var folder = DriveApp.getFolderById(folderId);
  var it = folder.getFiles(), sig = [];
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    if (!/\.csv$/i.test(name) && f.getMimeType() !== 'application/vnd.google-apps.spreadsheet') continue;
    sig.push(f.getId() + ':' + f.getLastUpdated().getTime() + ':' + f.getSize());
  }
  sig.sort();
  return sig.join('|');
}

/**
 * Core change-detector, shared by the 12-hour trigger AND the 30 s client poll.
 * Compares the folder signature to the stored snapshot and dispatches on change.
 * Lock-guarded so concurrent callers (multiple browser sessions + the trigger)
 * can't both fire for the same change; they share one DRIVE_SNAPSHOT property.
 * Returns a short status string: unconfigured | busy | nochange | baseline | dispatched.
 */
function dwDetectAndDispatch_() {
  var cfg = dwConfig_();
  if (!cfg.folderId || !cfg.pat) return 'unconfigured';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'busy';            // another caller is checking — skip
  try {
    var snapshot = dwFolderSignature_(cfg.folderId);
    var prev = DW_PROPS.getProperty('DRIVE_SNAPSHOT');
    if (snapshot === prev) return 'nochange';
    DW_PROPS.setProperty('DRIVE_SNAPSHOT', snapshot);
    if (prev === null) return 'baseline';            // first run → just baseline, don't dispatch
    dwDispatch_(cfg);
    return 'dispatched';
  } finally {
    lock.releaseLock();
  }
}

/** 12-hour time-driven trigger handler (backstop for when the web app is closed). */
function checkDriveFolderForNewFiles_() {
  Logger.log('DriveWatch (backstop): ' + dwDetectAndDispatch_());
}

/**
 * Client-callable poll (called every ~30 s from the open web app, alongside
 * pollChanges). Runs as the viewer, so it only detects changes for a viewer who
 * can see the folder (the owner); other viewers hit a Drive-access error which we
 * swallow. Gives sub-minute updates when the app is open; the 12-hour trigger
 * covers the rest.
 */
function pollDriveChanges() {
  try {
    return { status: dwDetectAndDispatch_() };
  } catch (e) {
    return { status: 'error', message: String(e) };   // e.g. viewer without folder access
  }
}

/** POST a repository_dispatch to GitHub. */
function dwDispatch_(cfg) {
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + cfg.repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + cfg.pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ event_type: cfg.eventType }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  Logger.log('DriveWatch dispatch → HTTP ' + code + (code === 204 ? ' (queued)' : ' ' + res.getContentText()));
}

/** Install the 12-hour backstop poll (idempotent) and seed the baseline so it won't fire immediately. */
function installDriveWatchTrigger() {
  removeDriveWatchTrigger();
  checkDriveFolderForNewFiles_();   // seeds DRIVE_SNAPSHOT baseline on first run
  ScriptApp.newTrigger('checkDriveFolderForNewFiles_').timeBased().everyHours(12).create();
  Logger.log('DriveWatch 12-hour backstop trigger installed.');
}

function removeDriveWatchTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkDriveFolderForNewFiles_') ScriptApp.deleteTrigger(t);
  });
}

/** Manual test: force a dispatch now (ignores the change check). */
function dwTestDispatch() {
  var cfg = dwConfig_();
  if (!cfg.folderId || !cfg.pat) { Logger.log('Not configured.'); return; }
  dwDispatch_(cfg);
}
