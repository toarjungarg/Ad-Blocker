#!/usr/bin/env python3
"""
convert.py: turns EasyList and EasyPrivacy into rule files the extension can load.

What is EasyList?
  EasyList and EasyPrivacy are two big public lists of ad servers and trackers,
  kept up to date by volunteers (https://easylist.to). Every line is one filter,
  written in "Adblock Plus" syntax. Chrome cannot read that syntax directly, so
  this script translates the lines it understands into Chrome's own rule format
  (declarativeNetRequest, "DNR") and throws the rest away (and counts why).

What this script writes (in the rules/ folder):
  rules/network.json  rules that block or allow web requests (loaded by background.js)
  rules/hide.json     CSS selectors for page elements to hide (ad boxes and so on)
  rules/meta.json     the build date and some counts (the popup reads this)

How to run it (from the project folder):
  python3 tools/convert.py --download          fetch fresh lists from the internet, then convert
  python3 tools/convert.py --lists <folder>    convert lists you already have in <folder>
  python3 tools/convert.py                     convert the lists in lists/ (the default folder)
  Extra option: --out <folder> writes the rule files somewhere other than rules/.
  Only --download touches the internet. Run it yourself, it is never needed for tests.
  After converting, reload the extension in chrome://extensions so it picks up the new rules.

Why rules/ and lists/ are not in Git:
  EasyList is dual licensed (GPLv3 and CC BY-SA 3.0), which is a different licence from
  this project. So the lists and the rule files made from them are not committed. Each
  person runs this script to make their own copy.

Only Python's built-in modules are used (nothing to install). Works on Python 3.9.
"""

import argparse
import collections
import datetime
import json
import os
import re
import sys
import time
import urllib.request

# ---------------------------------------------------------------- settings
# Every tunable number and list lives up here so a change happens in one place.

# The most converted network rules we write. Chrome allows 30,000 dynamic rules and
# one of them is the user's allowlist rule, so we stop a little short of that.
# background.js has the same number (MAX_CONVERTED_RULES): change both together.
MAX_NETWORK_RULES = 29900

# Where the lists come from (only used with --download).
LIST_URLS = {
    "easylist.txt": "https://easylist.to/easylist/easylist.txt",
    "easyprivacy.txt": "https://easylist.to/easylist/easyprivacy.txt",
}

# The list files, in the order they are converted. Earlier lists win if the rule
# limit is hit, so EasyList (ads) comes before EasyPrivacy (trackers).
LIST_FILES = ["easylist.txt", "easyprivacy.txt"]

# The most requestDomains one grouped rule may hold. Chrome has no documented cap,
# but smaller rules are safer to load, and one bad domain only spoils one small rule.
# Bigger groups are split into pieces (the sorted domains stay in order).
MAX_DOMAINS_PER_RULE = 1000

# How long to wait for the internet before giving up on a download (seconds).
DOWNLOAD_TIMEOUT_SECONDS = 60

# Name we give the website when downloading. Plain and generic on purpose.
DOWNLOAD_USER_AGENT = "adblocker-list-converter"

# Priorities: when two rules match the same request, the higher number wins.
# The user's allowlist rule (made in background.js) uses 100, above all of these.
BLOCK_PRIORITY = 1       # normal block rule
ALLOW_PRIORITY = 2       # exception rule (@@), beats a normal block
IMPORTANT_PRIORITY = 3   # block rule marked $important, beats an exception

# ABP resource type names (left) and the names Chrome uses (right).
RESOURCE_TYPE_MAP = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "object": "object",
    "xmlhttprequest": "xmlhttprequest",
    "subdocument": "sub_frame",
    "media": "media",
    "font": "font",
    "ping": "ping",
    "websocket": "websocket",
    "other": "other",
}

# Every resource type name Chrome accepts. Used by the safety check at the end.
VALID_RESOURCE_TYPES = {
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
    "webbundle", "other",
}

# $third-party style options and the Chrome domainType they turn into.
# The "~" (not) versions mean the opposite.
THIRD_PARTY_OPTIONS = {
    "third-party": "thirdParty",
    "3p": "thirdParty",
    "first-party": "firstParty",
    "1p": "firstParty",
}
OPPOSITE_DOMAIN_TYPE = {"thirdParty": "firstParty", "firstParty": "thirdParty"}

# Cosmetic (hiding) markers we cannot use, with the reason shown in the summary.
# A normal hide line uses ## and an exception uses #@#, those are handled in the code.
UNSUPPORTED_HIDE_MARKERS = {
    "#?#": "hide: extended selector (#?#)",
    "#@?#": "hide: extended selector exception (#@?#)",
    "#$#": "hide: style injection (#$#)",
    "#@$#": "hide: style injection exception (#@$#)",
    "#%#": "hide: script rule (#%#)",
    "#@%#": "hide: script rule exception (#@%#)",
}

# Selectors using these are not real CSS (they are tricks only some blockers
# understand), so a browser would ignore or reject them. We skip the whole line.
# :has( and :not( are real CSS and are NOT in this list.
UNSUPPORTED_PSEUDO_CLASSES = [
    ":-abp-", ":has-text(", ":contains(", ":xpath(", ":matches-css", ":upward(",
    ":remove(", ":style(", ":min-text-length(", ":watch-attr(", ":matches-path(",
    ":others(", ":matches-attr(", ":matches-prop(", ":nth-ancestor(", ":if(",
    ":if-not(", ":remove-attr(", ":remove-class(",
]

# A selector with any of these could break out of the "selector{display:none}" CSS
# that background.js builds (for example by closing the rule early), so we skip it.
UNSAFE_SELECTOR_TEXT = ["{", "}", "/*", "*/", "\\\n"]

# ---------------------------------------------------------------- patterns

# A line that hides things: optional domain list, then a marker, then a selector.
# It must not start with | or @ (those are network rules like ||host^ or @@||host^).
HIDE_LINE_RE = re.compile(
    r"^([^|@\s]*?)(##|#@#|#\?#|#@\?#|#\$#|#@\$#|#%#|#@%#)(.*)$"
)

# A hostname made of lowercase letters, digits, dots and dashes, not starting or
# ending with a dot or dash. Used to check domains in rules.
DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")

# A "whole server" network line: exactly ||host^ and nothing else.
# (Case is ignored here and the host is lowercased afterwards.)
WHOLE_SERVER_RE = re.compile(r"^\|\|([a-z0-9]([a-z0-9.-]*[a-z0-9])?)\^$", re.IGNORECASE)

# A regex filter is written between slashes, like /ads[0-9]+/ (maybe with $options after).
REGEX_LINE_RE = re.compile(r"^(@@)?/.+/(\$.*)?$")

# Looks like an IPv4 address (digits and dots only). Those stay as urlFilter rules.
IP_LIKE_RE = re.compile(r"^[0-9.]+$")


# ---------------------------------------------------------------- small helpers

def is_ascii(text):
    """True if every character is plain ASCII (Chrome needs that for urlFilter and domains)."""
    return all(ord(ch) < 128 for ch in text)


def classify_line(line):
    """Decide what kind of line this is: "ignore", "hide" or "network".

    "ignore" means blank lines, comments (start with !) and the [Adblock Plus ...] header.
    "hide" means a cosmetic line (## and friends), "network" means everything else.
    """
    if line == "" or line.startswith("!") or line.startswith("["):
        return "ignore"
    if HIDE_LINE_RE.match(line):
        return "hide"
    return "network"


# ---------------------------------------------------------------- network lines

def parse_options(option_text, is_allow):
    """Turn the text after the $ into a Chrome condition and a priority.

    Returns (condition, priority, reason). If the line must be skipped, condition and
    priority are None and reason says why. The condition has no urlFilter yet.
    """
    domain_type = None
    types = set()
    excluded_types = set()
    initiator = []
    excluded_initiator = []
    case_sensitive = False
    important = False

    for raw in option_text.split(","):
        option = raw.strip()
        if option == "":
            continue
        lowered = option.lower()
        name = lowered.split("=", 1)[0]

        # $third-party and friends.
        bare = name[1:] if name.startswith("~") else name
        if bare in THIRD_PARTY_OPTIONS:
            wanted = THIRD_PARTY_OPTIONS[bare]
            if name.startswith("~"):
                wanted = OPPOSITE_DOMAIN_TYPE[wanted]
            if domain_type is not None and domain_type != wanted:
                return None, None, "conflicting third-party options"
            domain_type = wanted
            continue

        # Resource types, like $script or $~image.
        if bare in RESOURCE_TYPE_MAP and "=" not in lowered:
            if name.startswith("~"):
                excluded_types.add(RESOURCE_TYPE_MAP[bare])
            else:
                types.add(RESOURCE_TYPE_MAP[bare])
            continue

        # $domain=a.com|~b.com
        if name == "domain" and "=" in lowered:
            value = lowered.split("=", 1)[1]
            for entry in value.split("|"):
                negated = entry.startswith("~")
                host = entry[1:] if negated else entry
                if not DOMAIN_RE.match(host):
                    return None, None, "bad domain= value"
                (excluded_initiator if negated else initiator).append(host)
            continue

        if name == "match-case":
            case_sensitive = True
            continue

        if name == "important":
            if is_allow:
                return None, None, "important on an exception rule"
            important = True
            continue

        # Anything else (popup, document, redirect, csp, removeparam, ...) is not
        # something a plain block rule can do, so the whole line is skipped.
        return None, None, "unsupported option: " + name

    # A type both allowed and not allowed makes no sense, skip it.
    if types & excluded_types:
        return None, None, "conflicting resource types"

    # Build the condition. Empty lists are left out (Chrome rejects empty lists).
    condition = {}
    if initiator:
        condition["initiatorDomains"] = sorted(set(initiator))
    if excluded_initiator:
        condition["excludedInitiatorDomains"] = sorted(set(excluded_initiator))
    if domain_type:
        condition["domainType"] = domain_type
    if types:
        condition["resourceTypes"] = sorted(types)
    if excluded_types:
        condition["excludedResourceTypes"] = sorted(excluded_types)
    condition["isUrlFilterCaseSensitive"] = case_sensitive

    if important:
        priority = IMPORTANT_PRIORITY
    elif is_allow:
        priority = ALLOW_PRIORITY
    else:
        priority = BLOCK_PRIORITY
    return condition, priority, None


def parse_network_line(line):
    """Parse one network filter line (one that starts with || or @@||).

    Returns (entry, reason). When the line can be used, entry is a dict:
      {"action": "block" or "allow", "priority": n, "url_filter": "||host^...",
       "host": "host" if the pattern is exactly ||host^ (a whole server), else None,
       "condition": {...everything except urlFilter/requestDomains...}}
    and reason is None. When the line must be skipped, entry is None and reason is a
    short text for the summary.
    """
    line = line.strip()
    if not is_ascii(line):
        return None, "non-ASCII characters"

    if line.startswith("@@||"):
        is_allow = True
        body = line[2:]          # drop the @@, keep the ||
    elif line.startswith("||"):
        is_allow = False
        body = line
    elif REGEX_LINE_RE.match(line):
        return None, "regex rule"
    else:
        return None, "plain path rule (no ||)"

    # Split off the options. The options start after the last $.
    pattern = body
    option_text = ""
    if "$" in body:
        pattern, option_text = body.rsplit("$", 1)
    pattern = pattern.strip()
    if pattern in ("||", ""):
        return None, "empty pattern"

    condition, priority, reason = parse_options(option_text, is_allow)
    if reason:
        return None, reason

    # A whole-server line is exactly ||host^ (and the host is not an IP address).
    # ||host^| is NOT treated as whole-server: the final | means "the URL ends here",
    # which is narrower than blocking the whole host.
    host = None
    match = WHOLE_SERVER_RE.match(pattern)
    if match and not IP_LIKE_RE.match(match.group(1)):
        host = match.group(1).lower()

    entry = {
        "action": "allow" if is_allow else "block",
        "priority": priority,
        "url_filter": pattern,
        "host": host,
        "condition": condition,
    }
    return entry, None


def condition_key(condition):
    """A text version of a condition, so equal conditions can be compared and grouped."""
    return json.dumps(condition, sort_keys=True)


def group_whole_server_rules(entries):
    """Merge whole-server entries into shared rules and keep the others as they are.

    Entries that are exactly ||host^ and have the same action, priority and other
    conditions become ONE rule with a requestDomains list (sorted, no duplicates)
    and no urlFilter (split into several rules if there are more than
    MAX_DOMAINS_PER_RULE domains). All other entries become one rule each with a urlFilter.

    Returns a list of draft rules (no id yet):
      {"action", "priority", "condition", "lines": source lines used, "domains": n}
    The grouped rules come first, then the single rules in file order. That way, if the
    rule limit cuts the end off, the big ad-server groups are the last to go.
    """
    groups = collections.OrderedDict()   # key -> {"proto": entry, "hosts": set(), "lines": n}
    singles = []
    for entry in entries:
        if entry["host"] is None:
            condition = {"urlFilter": entry["url_filter"]}
            condition.update(entry["condition"])
            singles.append({
                "action": entry["action"],
                "priority": entry["priority"],
                "condition": condition,
                "lines": 1,
                "domains": 0,
            })
            continue
        key = (entry["action"], entry["priority"], condition_key(entry["condition"]))
        if key not in groups:
            groups[key] = {"proto": entry, "hosts": set(), "lines": 0}
        groups[key]["hosts"].add(entry["host"])
        groups[key]["lines"] += 1

    grouped = []
    for group in groups.values():
        proto = group["proto"]
        hosts = sorted(group["hosts"])
        # Split into pieces of at most MAX_DOMAINS_PER_RULE domains each.
        for start in range(0, len(hosts), MAX_DOMAINS_PER_RULE):
            piece = hosts[start:start + MAX_DOMAINS_PER_RULE]
            condition = {"requestDomains": piece}
            condition.update(proto["condition"])
            grouped.append({
                "action": proto["action"],
                "priority": proto["priority"],
                "condition": condition,
                "lines": len(piece),   # every host came from at least one line
                "domains": len(piece),
            })
    return grouped + singles


def validate_rule(rule, allow_main_frame=False):
    """Safety check for one rule. Returns None if it is fine, or a short reason if not.

    This is the last gate before a rule is written: Chrome rejects (or misreads) rules
    that break these checks, and one bad rule could cost a whole chunk of rules.
    """
    action = rule.get("action")
    condition = rule.get("condition")
    if not isinstance(action, dict) or action.get("type") not in ("block", "allow"):
        return "bad action"
    if not isinstance(condition, dict):
        return "bad condition"
    if "id" in rule and (not isinstance(rule["id"], int) or rule["id"] < 1):
        return "bad id"
    if not isinstance(rule.get("priority"), int):
        return "bad priority"

    # Exactly one of urlFilter and requestDomains. With neither, the rule would match
    # every request, which would be a disaster.
    has_filter = "urlFilter" in condition
    has_domains = "requestDomains" in condition
    if has_filter and has_domains:
        return "rule has both urlFilter and requestDomains"
    if not has_filter and not has_domains:
        return "rule has no urlFilter or requestDomains"

    if has_filter:
        url_filter = condition["urlFilter"]
        if not isinstance(url_filter, str) or url_filter == "":
            return "empty urlFilter"
        if not is_ascii(url_filter):
            return "non-ASCII urlFilter"
        if url_filter.startswith("||*"):
            return "urlFilter starts with ||*"
        if any(ch.isspace() for ch in url_filter):
            return "urlFilter has whitespace"

    for field in ("requestDomains", "initiatorDomains", "excludedInitiatorDomains"):
        if field in condition:
            domains = condition[field]
            if not isinstance(domains, list) or len(domains) == 0:
                return "empty " + field
            for domain in domains:
                if not isinstance(domain, str) or not DOMAIN_RE.match(domain):
                    return "bad domain in " + field

    for field in ("resourceTypes", "excludedResourceTypes"):
        if field in condition:
            types = condition[field]
            if not isinstance(types, list) or len(types) == 0:
                return "empty " + field
            for name in types:
                if name not in VALID_RESOURCE_TYPES:
                    return "unknown resource type"
    if (not allow_main_frame and action["type"] == "block"
            and "main_frame" in condition.get("resourceTypes", [])):
        return "block rule on main_frame"

    return None


def build_network_rules(lists, max_rules=None):
    """Turn parsed network entries into the final rule list.

    lists: [(list_name, [entry, ...]), ...] in the order they should be kept.
    Steps: group whole-server entries, validate, drop duplicates, cut at max_rules
    (None means MAX_NETWORK_RULES), then put block rules first (ids 1..blockRules)
    and allow rules after them.

    Returns (rules, stats). stats has counts for the summary.
    """
    # Python works out a default value once, when the function is defined. A default
    # of MAX_NETWORK_RULES would freeze the number at that moment, so a changed
    # constant would be ignored. None plus this line reads it fresh on every call.
    if max_rules is None:
        max_rules = MAX_NETWORK_RULES
    # Order for the cut: for each list, allow rules first, then block rules.
    # (Keeping exceptions matters: they stop false positives.)
    ordered = []
    for name, entries in lists:
        drafts = group_whole_server_rules(entries)
        for action in ("allow", "block"):
            for draft in drafts:
                if draft["action"] == action:
                    draft["source"] = name
                    ordered.append(draft)

    invalid = collections.Counter()
    duplicates = 0
    valid = []
    seen = set()
    for draft in ordered:
        reason = validate_rule({
            "priority": draft["priority"],
            "action": {"type": draft["action"]},
            "condition": draft["condition"],
        })
        if reason:
            invalid[reason] += 1
            continue
        key = (draft["action"], draft["priority"], condition_key(draft["condition"]))
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        valid.append(draft)

    kept = valid[:max_rules]
    cut_drafts = valid[max_rules:]

    # Block rules first, then allow rules, so a block rule's id is always
    # between 1 and blockRules (the popup uses that to count blocks).
    block_drafts = [d for d in kept if d["action"] == "block"]
    allow_drafts = [d for d in kept if d["action"] == "allow"]
    rules = []
    for draft in block_drafts + allow_drafts:
        rules.append({
            "id": len(rules) + 1,
            "priority": draft["priority"],
            "action": {"type": draft["action"]},
            "condition": draft["condition"],
        })

    by_source = collections.OrderedDict()
    for name, _entries in lists:
        by_source[name] = {"block": 0, "allow": 0, "domains": 0}
    for draft in kept:
        info = by_source[draft["source"]]
        info[draft["action"]] += 1
        info["domains"] += draft["domains"]

    stats = {
        "block": len(block_drafts),
        "allow": len(allow_drafts),
        "grouped_rules": sum(1 for d in kept if d["domains"] > 0),
        "grouped_domains": sum(d["domains"] for d in kept),
        "invalid": invalid,
        "duplicates": duplicates,
        "cut": len(cut_drafts),
        "cut_lines": sum(d["lines"] for d in cut_drafts),
        "by_source": by_source,
    }
    return rules, stats


# ---------------------------------------------------------------- hide lines

def is_balanced_selector(selector):
    """True when every bracket and quote in the selector is closed properly.

    A selector like "div[bad" would make the browser read on into the next CSS
    rules and lose them, so such selectors are skipped here and never reach
    hide.json. Same walk as isBalancedSelector in background.js:
    quotes (' and ") hide everything inside them, a backslash escapes the next
    character, and [ ( must be closed by the matching ] ).
    """
    stack = []
    quote = None  # the quote character we are inside, or None
    i = 0
    while i < len(selector):
        ch = selector[i]
        if ch == "\\":
            i += 2  # skip the escaped character
            continue
        if quote is not None:
            if ch == quote:
                quote = None
        elif ch in ('"', "'"):
            quote = ch
        elif ch in "[(":
            stack.append(ch)
        elif ch in "])":
            opener = stack.pop() if stack else None
            if (ch == "]" and opener != "[") or (ch == ")" and opener != "("):
                return False
        i += 1
    return quote is None and not stack


def parse_hide_line(line):
    """Parse one cosmetic line (## or #@# and friends).

    Returns (result, reason). result is
      {"selector": str, "include": [domains], "exclude": [domains], "exception": bool}
    or None with a reason when the line is skipped. "exclude" holds domains that were
    written with a ~ (not on this site).
    """
    match = HIDE_LINE_RE.match(line.strip())
    if not match:
        return None, "hide: not a hide line"
    domain_text, marker, selector = match.group(1), match.group(2), match.group(3).strip()

    if marker in UNSUPPORTED_HIDE_MARKERS:
        return None, UNSUPPORTED_HIDE_MARKERS[marker]
    is_exception = marker == "#@#"

    if selector.startswith("+js"):
        return None, "hide: scriptlet (##+js)"
    if selector.startswith("^"):
        return None, "hide: HTML filter (##^)"
    if selector == "":
        return None, "hide: empty selector"
    for bad in UNSUPPORTED_PSEUDO_CLASSES:
        if bad in selector:
            return None, "hide: unsupported pseudo-class"
    for bad in UNSAFE_SELECTOR_TEXT:
        if bad in selector:
            return None, "hide: unsafe characters in selector"
    if selector.startswith("@"):
        return None, "hide: unsafe characters in selector"
    if not is_balanced_selector(selector):
        return None, "hide: unbalanced selector"

    include = []
    exclude = []
    if domain_text != "":
        for raw in domain_text.split(","):
            domain = raw.strip().lower()
            negated = domain.startswith("~")
            if negated:
                domain = domain[1:]
            if "*" in domain or "/" in domain:
                return None, "hide: wildcard or path in domain"
            if not DOMAIN_RE.match(domain):
                return None, "hide: odd domain"
            (exclude if negated else include).append(domain)

    if is_exception:
        if not include and not exclude:
            return None, "hide: generic exception (#@#)"
        if exclude:
            return None, "hide: negated domain in exception"

    return {
        "selector": selector,
        "include": include,
        "exclude": exclude,
        "exception": is_exception,
    }, None


def build_hide_data(results):
    """Fold parsed hide lines into the hide.json structure.

    Rules (from the spec):
      ##sel                  -> generic
      a.com,b.com##sel       -> sites[a.com] and sites[b.com]
      ~a.com##sel (only ~)   -> generic, plus siteExceptions[a.com]
      a.com,~b.com##sel      -> sites[a.com], plus siteExceptions[b.com]
      a.com#@#sel            -> siteExceptions[a.com]
    Selectors are de-duplicated and domains are already lowercase.
    Returns (hide_dict, stats).
    """
    generic = collections.OrderedDict()
    sites = {}
    exceptions = {}

    def add(table, domain, selector):
        table.setdefault(domain, collections.OrderedDict())[selector] = None

    for result in results:
        selector = result["selector"]
        if result["exception"]:
            for domain in result["include"]:
                add(exceptions, domain, selector)
            continue
        if not result["include"]:
            generic[selector] = None            # no domains, or only ~domains
        for domain in result["include"]:
            add(sites, domain, selector)
        for domain in result["exclude"]:
            add(exceptions, domain, selector)

    hide = {
        "generic": list(generic.keys()),
        "sites": dict((d, list(sites[d].keys())) for d in sorted(sites)),
        "siteExceptions": dict((d, list(exceptions[d].keys())) for d in sorted(exceptions)),
    }
    stats = {
        "generic": len(hide["generic"]),
        "site": sum(len(v) for v in hide["sites"].values()),
        "exceptions": sum(len(v) for v in hide["siteExceptions"].values()),
    }
    return hide, stats


# ---------------------------------------------------------------- files

def read_list_lines(path):
    """Read a list file and return its lines without the line endings."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return [line.rstrip("\r\n") for line in handle]


def download_lists(lists_dir):
    """Fetch the lists from the internet into lists_dir. Returns True on success.

    Only a person should run this (through --download).
    """
    os.makedirs(lists_dir, exist_ok=True)
    for file_name in LIST_FILES:
        url = LIST_URLS[file_name]
        target = os.path.join(lists_dir, file_name)
        print("Downloading " + url + " ...")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": DOWNLOAD_USER_AGENT})
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                data = response.read()
        except OSError as error:
            # URLError, HTTPError and timeouts are all kinds of OSError.
            print("Could not download " + url + ": " + str(error), file=sys.stderr)
            print("Check your internet connection and try again, or put the file in "
                  + lists_dir + " yourself.", file=sys.stderr)
            return False
        # A real list starts with a [Adblock ...] header or a ! comment. If not, we
        # probably got an error page, so do not overwrite the good file.
        if not (data.startswith(b"[") or data.startswith(b"!")):
            print("The download from " + url + " does not look like a filter list.",
                  file=sys.stderr)
            return False
        # Write to a temporary file first so a half-finished download never replaces a good list.
        temp_path = target + ".tmp"
        try:
            with open(temp_path, "wb") as handle:
                handle.write(data)
            os.replace(temp_path, target)
        except OSError as error:
            print("Could not save " + target + ": " + str(error), file=sys.stderr)
            return False
        print("  saved " + target + " (" + str(len(data)) + " bytes)")
    return True


def write_json(path, data):
    """Write compact JSON (no spaces) to keep the files small."""
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, separators=(",", ":"), ensure_ascii=False)


def format_size(num_bytes):
    """Bytes as a short readable size, like 1.4 MB."""
    if num_bytes >= 1024 * 1024:
        return "%.1f MB" % (num_bytes / (1024.0 * 1024.0))
    if num_bytes >= 1024:
        return "%.1f KB" % (num_bytes / 1024.0)
    return str(num_bytes) + " bytes"


# ---------------------------------------------------------------- main

def convert_lists(list_paths, max_rules=None):
    """Run the whole conversion in memory.

    list_paths: [(list_name, path), ...]. max_rules=None means MAX_NETWORK_RULES.
    Returns (rules, hide, meta, report) where report holds the numbers for the summary.
    """
    # Same reason as in build_network_rules: read the constant at call time,
    # not when the function is defined.
    if max_rules is None:
        max_rules = MAX_NETWORK_RULES
    network_lists = []
    hide_results = []
    network_skips = collections.Counter()
    hide_skips = collections.Counter()
    ignored = 0
    line_counts = collections.OrderedDict()

    for name, path in list_paths:
        entries = []
        total = 0
        for line in read_list_lines(path):
            total += 1
            kind = classify_line(line)
            if kind == "ignore":
                ignored += 1
            elif kind == "hide":
                result, reason = parse_hide_line(line)
                if result:
                    hide_results.append(result)
                else:
                    hide_skips[reason] += 1
            else:
                entry, reason = parse_network_line(line)
                if entry:
                    entries.append(entry)
                else:
                    network_skips[reason] += 1
        network_lists.append((name, entries))
        line_counts[name] = {"lines": total, "network_kept": len(entries)}

    rules, net_stats = build_network_rules(network_lists, max_rules)
    hide, hide_stats = build_hide_data(hide_results)

    block_count = net_stats["block"]
    skipped = (sum(network_skips.values()) + sum(hide_skips.values())
               + sum(net_stats["invalid"].values()) + net_stats["duplicates"])
    meta = {
        "built": datetime.date.today().isoformat(),   # local date, YYYY-MM-DD
        "blockRules": block_count,
        "allowRules": net_stats["allow"],
        "genericHide": hide_stats["generic"],
        "siteHide": hide_stats["site"],
        "skipped": skipped,
        "cut": net_stats["cut"],
        "sources": list(LIST_FILES),
    }
    report = {
        "ignored": ignored,
        "network_skips": network_skips,
        "hide_skips": hide_skips,
        "net_stats": net_stats,
        "hide_stats": hide_stats,
        "line_counts": line_counts,
    }
    return rules, hide, meta, report


def print_summary(meta, report, out_files, seconds):
    """Print the readable summary at the end."""
    net = report["net_stats"]
    hide = report["hide_stats"]
    print("")
    print("=== Summary ===")
    print("Network rules kept:   %d block, %d allow (limit %d)"
          % (net["block"], net["allow"], MAX_NETWORK_RULES))
    for name, info in net["by_source"].items():
        print("  from %-16s %d block + %d allow = %d rules"
              % (name + ":", info["block"], info["allow"], info["block"] + info["allow"]))
    print("  grouped rules: %d rules hold %d domains in requestDomains"
          % (net["grouped_rules"], net["grouped_domains"]))
    print("Hide selectors kept:  %d generic, %d site-specific, %d site exceptions"
          % (hide["generic"], hide["site"], hide["exceptions"]))
    print("Cut by the limit:     %d rules (%d source lines)" % (net["cut"], net["cut_lines"]))
    print("Skipped in total:     %d lines (comments and blanks not counted: %d)"
          % (meta["skipped"], report["ignored"]))
    print("Skipped network lines by reason:")
    for reason, count in report["network_skips"].most_common():
        print("  %7d  %s" % (count, reason))
    print("Dropped by the safety check or as duplicates:")
    if not net["invalid"] and net["duplicates"] == 0:
        print("  %7d" % 0)
    for reason, count in net["invalid"].most_common():
        print("  %7d  %s" % (count, reason))
    if net["duplicates"]:
        print("  %7d  duplicate rule" % net["duplicates"])
    print("Skipped hide lines by reason:")
    for reason, count in report["hide_skips"].most_common():
        print("  %7d  %s" % (count, reason))
    print("Files written:")
    for path in out_files:
        # Show the path relative to where you ran the script, so it stays short.
        print("  %s  %s" % (os.path.relpath(path), format_size(os.path.getsize(path))))
    print("Built on %s in %.1f seconds." % (meta["built"], seconds))


def main(argv=None):
    """Command line entry point. Returns the exit code (0 means success)."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(
        description="Convert EasyList and EasyPrivacy into rules for the extension.")
    parser.add_argument("--lists", default=os.path.join(root, "lists"),
                        help="folder holding easylist.txt and easyprivacy.txt (default: lists/)")
    parser.add_argument("--out", default=os.path.join(root, "rules"),
                        help="folder to write the rule files into (default: rules/)")
    parser.add_argument("--download", action="store_true",
                        help="download fresh lists into the lists folder first")
    args = parser.parse_args(argv)

    started = time.perf_counter()

    if args.download:
        if not download_lists(args.lists):
            return 1

    list_paths = []
    for file_name in LIST_FILES:
        path = os.path.join(args.lists, file_name)
        if not os.path.isfile(path):
            print("Missing list file: " + path, file=sys.stderr)
            print("Get the lists by running:  python3 tools/convert.py --download", file=sys.stderr)
            print("or put easylist.txt and easyprivacy.txt in " + args.lists
                  + " and use --lists.", file=sys.stderr)
            return 1
        list_paths.append((file_name, path))

    rules, hide, meta, report = convert_lists(list_paths)

    os.makedirs(args.out, exist_ok=True)
    network_path = os.path.join(args.out, "network.json")
    hide_path = os.path.join(args.out, "hide.json")
    meta_path = os.path.join(args.out, "meta.json")
    write_json(network_path, rules)
    write_json(hide_path, hide)
    write_json(meta_path, meta)

    print_summary(meta, report, [network_path, hide_path, meta_path],
                  time.perf_counter() - started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
