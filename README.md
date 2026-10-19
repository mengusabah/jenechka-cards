# Jenechka Cards

A simple, installable flashcard app for studying vocabulary in both directions.

Create and edit decks, practice source-to-target or target-to-source, and use mixed mode to study every card in both directions in shuffled order. A deck of 10 cards gives 20 questions in mixed mode. Mark a question **Again** to revisit that direction or **Good** to finish it. The app includes offline study, home screen icons, and JSON export/import.

Both language menus include English, Turkish, German, Spanish, French, Italian, Russian, Portuguese, Chinese, Japanese, Korean, Arabic, and Dutch. Choose **Other (type a language)** to enter another language; existing custom language names are preserved when editing.

Live site: <https://mengusabah.github.io/jenechka-cards/>

## A small welcome

The chibi mascot greets you on your first visit and after at least 2 hours away. Its gentle entrance fades into the app automatically in about two seconds, with no buttons to press. Reduced-motion preferences bypass it. Returning to a tab after a short break does not replay it. The greeting works offline and never changes your decks.

## Install on iPhone

1. Open the site in Safari. If you already have words saved there, use **App & Backups → Download backup** first.
2. Choose **Share → Add to Home Screen**. Leave **Open as Web App** enabled if that option appears.
3. Launch the new home screen icon while online and wait for **Ready offline**.
4. If your Safari decks are not present, open **App & Backups** and import your backup. Safari and the installed app may have separate data stores.

The installed app opens without the Safari toolbar. The layout respects iPhone safe areas and dynamic screen height. Offline use requires one successful online setup in that browser or installed app. On supported desktop and Android browsers, an **Install app** button also appears.

## Back up and restore

**App & Backups** exports all saved decks as a versioned JSON file. On supported devices, **Save / Share backup** opens the system share sheet so you can choose Files or iCloud Drive. The editor also has **Download draft backup** to preserve completed edits if a save fails.

Choose a JSON backup to see its deck/card counts before importing. Imports preserve current decks, skip identical content, and add changed decks as separate copies. Invalid files are rejected without changing saved data. Legacy deck arrays are accepted. A file and the combined collection must fit within the 10 MiB backup limit.

## Run locally

No dependencies or build step are required. Serve this folder with a local HTTP server:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000> in a modern browser.

Run the dependency-free checks with Node 20 or newer:

```sh
npm test
```

## GitHub Pages

The site is published from the root of the `main` branch. In the repository's **Settings → Pages**, choose **Deploy from a branch**, then **main** and **/ (root)**. The `.nojekyll` file enables plain static hosting.

Updates pushed to `main` are published automatically.

When changing any application file, bump `VERSION` in `sw.js`. The worker precaches the full application shell under this project's scope. A waiting update is offered when the user is not editing or studying; it can also activate after all app windows close. All asset paths are relative so deployment under `/jenechka-cards/` works.

## Storage

Decks are stored in IndexedDB using completed transactions, with revision checks to prevent one tab from silently overwriting changes from another. Existing `jenechka-cards-v1` localStorage decks migrate automatically and the original is retained. A best-effort recovery copy is kept locally; it is not a substitute for an exported backup. If IndexedDB is initially unavailable, browser storage with cross-tab locking is used when supported. If data cannot be read or saved safely, the app reports it and does not claim a successful save.

**Request storage protection** asks the browser for persistent storage. Granting it is browser-controlled; [WebKit documents its storage policy and Home Screen heuristics](https://webkit.org/blog/14403/updates-to-storage-policy/). Clearing website data, removing an installed app, or device storage cleanup can still lose local data, so keep regular exported backups. There is no cloud synchronization or account. Local preview, Safari, and installed-app storage may be separate.

Only application assets are cached by the service worker. Decks and imported/exported backups are never uploaded to GitHub or added to that static asset cache.

## License

This project is licensed under the [MIT License](LICENSE). You may use, modify, and distribute the code, including commercially, provided the copyright and license notice are retained. See the license for the full terms and warranty disclaimer.
