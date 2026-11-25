# Ad-Blocker

A Chrome extension that blocks ads and trackers. I built it to learn how Chrome extensions and ad blocking actually work.

It does three things:

1. **Blocks requests to ad and tracker servers.** It uses Chrome's `declarativeNetRequest` API, so Chrome itself checks each request against the rules and cancels the ad ones before they download. The extension never reads your traffic.
2. **Hides leftover ad boxes.** A content script asks the background service worker to add CSS that hides elements matching known ad patterns (like `ins.adsbygoogle`), so pages don't end up with empty gaps.
3. **Has a popup** that shows how many requests were blocked on the current page, a switch to turn blocking off for the current site, and the date the rules were built. The date turns orange when the rules are more than 30 days old.

The toolbar icon also shows the blocked count for each tab.

## Privacy

The extension collects nothing and sends nothing anywhere. It has no analytics, no logging to a server, and it never downloads anything by itself. The only thing it saves is your list of sites with blocking turned off, in Chrome's local extension storage.

It does ask for access to all sites, because it has to add the hiding CSS to every page you open.

## Install (Load unpacked)

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the repo folder (the one with `manifest.json` in it).
5. Pin the extension from the puzzle piece menu so you can see its icon.

It works straight away with a small built-in set of rules (`base-rules.json` blocks about 36 of the biggest ad and tracker servers, and `base-hide.json` has about 20 common ad box patterns). To block much more, build the full rules from EasyList and EasyPrivacy as shown below.

## Build the full rules

The full rules come from [EasyList and EasyPrivacy](https://easylist.to), two big filter lists kept up to date by volunteers. They aren't in this repo (see Credits for why), so you make your own copy with `tools/convert.py`. It only needs Python 3, no packages.

From the repo folder:

```
python3 tools/convert.py --download
```

This downloads the two lists into `lists/` (two requests to easylist.to, a few MB) and writes the rule files into `rules/`. Then go to `chrome://extensions` and press the reload button on Ad-Blocker so it loads them.

If you already have the two files (`easylist.txt` and `easyprivacy.txt`) in a folder, you can skip the download:

```
python3 tools/convert.py --lists path/to/folder
```

What the converter does:

- Keeps "block this server" rules (`||server^` style) and their exceptions (`@@`), and turns them into Chrome's rule format. Rules that only block a whole server are grouped, so many servers share one Chrome rule.
- Keeps "hide this box" rules (`##selector`), both the ones for every site and the ones for one site.
- Skips everything else (scripts, advanced selectors, rule types Chrome can't do) and prints how many lines it skipped and why. Nothing from the lists can run code.
- Stops at 29,900 network rules, under Chrome's limit of 30,000 dynamic rules (one spot is kept for the allowlist rule). EasyList (ads) goes first, then EasyPrivacy (trackers). Right now both lists fit with lots of room to spare.

The lists change every day, so rerun the converter now and then and reload the extension. The popup's date turns orange after 30 days as a reminder.

## Test it

`test-page/` is a local page with fake ads. It requests files from every server in `base-rules.json` and has fake ad boxes, plus one box of real content that should stay visible.

```
python3 -m http.server 8000
```

Run that from the repo folder, then open `http://localhost:8000/test-page/`. With the extension on, every request should show as blocked and every fake ad box as hidden. Turn blocking off for `localhost` in the popup and they all come back. (Opening the file directly with `file://` doesn't work as well, because Chrome doesn't run extensions on local files unless you turn on "Allow access to file URLs".)

You can also open DevTools (F12), go to the Network tab and reload any page: blocked requests show in red as failed, with `net::ERR_BLOCKED_BY_CLIENT`.

The automated tests don't need Chrome:

```
python3 -m unittest discover -s tests -v
node --test tests/
```

## Files

| File | What it does |
|------|--------------|
| `manifest.json` | The extension's ID card: name, permissions and which files run where (Manifest V3) |
| `background.js` | Service worker: loads the converted rules, keeps the allowlist rule up to date, adds the hiding CSS |
| `content.js` | Runs on every page and asks the service worker to add the hiding CSS |
| `lib/sites.js` | Small shared helpers (site names, allowlist matching, rule age, blocked count) |
| `popup/` | The popup that opens when you click the icon |
| `base-rules.json`, `base-hide.json` | Built-in rules that work before you run the converter |
| `tools/convert.py` | Turns EasyList and EasyPrivacy into `rules/` |
| `test-page/` | Local fake ads page for testing by hand |
| `tests/` | Python and Node tests |

## Limits

- It can't block every ad. Ads served from the same server as the real content (search "Sponsored" results, social media feed ads, sponsor reads inside videos) can't be blocked by server, and hiding them breaks whenever the site changes its layout.
- YouTube video ads aren't handled.
- Lines EasyList writes in formats Chrome can't use (like plain path rules and popup rules) are skipped.
- If a site breaks, turn blocking off for it with the switch in the popup.

## Credits and licence

The filter rules come from [EasyList and EasyPrivacy](https://easylist.to) by the EasyList authors. Their lists are dual licensed under [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) and [Creative Commons Attribution-ShareAlike 3.0](https://creativecommons.org/licenses/by-sa/3.0/). That's a different licence from this project, so the lists and the rule files built from them are kept out of this repo (`lists/` and `rules/` are in `.gitignore`).

The code in this repo is under the MIT licence, see [LICENSE](LICENSE).
