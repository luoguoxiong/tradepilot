#!/usr/bin/env python3
"""Validate distributor-pipeline output directory.

Usage:
    python3 validate_output.py <output_dir>        # e.g. ./Carbon_Fiber_Insoles/分销商/
    python3 validate_output.py <file.json>         # single distributor file

Checks (pure stdlib, no deps):
  - distributor JSON: required top-level keys, types, score/level consistency,
    email_verification_status enum, authorized_status enum, evidence URL presence
    for key fields
  - index.json: stats consistency with per-distributor files

Exit code 0 = all pass, 1 = errors found.
"""

import json
import re
import sys
from pathlib import Path

REQUIRED_TOP = ["meta", "company", "distribution", "import_records", "contacts",
                "sourcing", "assessment", "data_confidence", "missing_information", "sources"]
LEVEL_BANDS = {"A": (80, 100), "B": (65, 79), "C": (50, 64), "D": (0, 49)}
EMAIL_STATUS = {"Valid", "Invalid", "Accept-all", "Unknown"}
AUTH_STATUS = {"Authorized", "Exclusive", "Non-authorized", "Unknown"}
CONFIDENCE = {"A", "B", "C", "D"}
INVEST_STATUS = {"completed", "no_data", "blocked"}
RELATIONSHIP = {"core", "new", "alternative", "supporting", "competitor", "Unknown"}

errors, warnings = [], []


def err(f, msg):
    errors.append(f"{f}: {msg}")


def warn(f, msg):
    warnings.append(f"{f}: {msg}")


def is_url(v):
    return isinstance(v, str) and v.startswith(("http://", "https://"))


def validate_distributor(path):
    f = str(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        err(f, f"invalid JSON ({e})")
        return None

    if not isinstance(data, dict):
        err(f, "top level must be an object")
        return None

    for k in REQUIRED_TOP:
        if k not in data:
            err(f, f"missing top-level key '{k}'")

    company = data.get("company")
    if isinstance(company, dict):
        if not str(company.get("company_name", "")).strip() or company.get("company_name") == "Unknown":
            err(f, "company.company_name must be a non-empty string")
    elif "company" in data:
        err(f, "company must be an object")

    dist = data.get("distribution")
    if isinstance(dist, dict):
        auth = dist.get("authorized_status")
        if auth is not None and auth not in AUTH_STATUS:
            err(f, f"distribution.authorized_status '{auth}' not in {sorted(AUTH_STATUS)}")
        if not str(dist.get("evidence_source", "")).strip():
            warn(f, "distribution.evidence_source empty (traceability rule)")
        cu = dist.get("catalogue_url")
        if cu not in (None, "Unknown") and not is_url(cu):
            warn(f, "distribution.catalogue_url is not a URL")
    elif "distribution" in data:
        err(f, "distribution must be an object")

    meta = data.get("meta")
    if isinstance(meta, dict):
        if meta.get("schema_version") != "1.0":
            warn(f, f"meta.schema_version should be '1.0', got {meta.get('schema_version')!r}")
        if not str(meta.get("generated_at", "")).strip():
            warn(f, "meta.generated_at is empty")
        if not str(meta.get("target_country", "")).strip():
            warn(f, "meta.target_country is empty")
    elif "meta" in data:
        err(f, "meta must be an object")

    for key in ("import_records", "contacts", "missing_information", "sources"):
        if key in data and not isinstance(data[key], list):
            err(f, f"'{key}' must be an array")

    for i, c in enumerate(data.get("contacts", [])):
        if not isinstance(c, dict):
            err(f, f"contacts[{i}] must be an object")
            continue
        status = c.get("email_verification_status")
        if status is not None and status not in EMAIL_STATUS:
            err(f, f"contacts[{i}].email_verification_status '{status}' not in {sorted(EMAIL_STATUS)}")
        if not str(c.get("contact_name", "")).strip() and not str(c.get("business_email", "")).strip():
            warn(f, f"contacts[{i}] has neither contact_name nor business_email")
        lp = c.get("linkedin_profile")
        if lp not in (None, "Unknown") and not is_url(lp):
            warn(f, f"contacts[{i}].linkedin_profile is not a URL")

    for i, r in enumerate(data.get("import_records", [])):
        if isinstance(r, dict) and not r.get("evidence_source"):
            warn(f, f"import_records[{i}] missing evidence_source (traceability rule)")

    src = data.get("sourcing")
    if isinstance(src, dict):
        if src.get("investigation_status") not in INVEST_STATUS:
            err(f, f"sourcing.investigation_status must be one of {sorted(INVEST_STATUS)}")
        for i, s in enumerate(src.get("suppliers", [])):
            if isinstance(s, dict) and s.get("relationship_type") not in RELATIONSHIP:
                err(f, f"sourcing.suppliers[{i}].relationship_type '{s.get('relationship_type')}' invalid")
    elif "sourcing" in data:
        err(f, "sourcing must be an object")

    a = data.get("assessment")
    if isinstance(a, dict):
        score = a.get("match_score")
        level = a.get("customer_level")
        if not isinstance(score, int) or not 0 <= score <= 100:
            err(f, f"assessment.match_score must be int 0-100, got {score!r}")
        elif level not in LEVEL_BANDS:
            err(f, f"assessment.customer_level '{level}' must be one of {sorted(LEVEL_BANDS)}")
        else:
            lo, hi = LEVEL_BANDS[level]
            if not lo <= score <= hi:
                err(f, f"match_score {score} inconsistent with customer_level {level} (band {lo}-{hi})")
        if "priority_rank" in a and not isinstance(a["priority_rank"], int):
            err(f, "assessment.priority_rank must be an int")
    elif "assessment" in data:
        err(f, "assessment must be an object")

    conf = data.get("data_confidence")
    if conf is not None and conf not in CONFIDENCE:
        err(f, f"data_confidence '{conf}' must be one of {sorted(CONFIDENCE)}")

    return data


def validate_index(path):
    f = str(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        err(f, f"invalid JSON ({e})")
        return []

    if not isinstance(data, dict) or not isinstance(data.get("distributors"), list):
        err(f, "index.distributors must be an array")
        return []

    slugs = []
    for i, it in enumerate(data.get("distributors", [])):
        if not isinstance(it, dict):
            err(f, f"index.distributors[{i}] must be an object")
            continue
        slug = it.get("distributor_slug")
        if not slug:
            err(f, f"index.distributors[{i}] missing distributor_slug")
        slugs.append(slug)
        jf, mf = it.get("json_file"), it.get("md_file")
        if not jf or not mf:
            warn(f, f"index.distributors[{i}] missing json_file/md_file")
            continue
        if not (path.parent / jf).exists():
            err(f, f"index.distributors[{i}] json_file '{jf}' does not exist on disk")
        if not (path.parent / mf).exists():
            warn(f, f"index.distributors[{i}] md_file '{mf}' does not exist on disk")

    dupes = {s for s in slugs if s and slugs.count(s) > 1}
    if dupes:
        err(f, f"duplicate distributor_slug in index: {sorted(dupes)}")
    return slugs


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    target = Path(sys.argv[1]).resolve()
    if target.is_file():
        files = [target]
        base = target.parent
    elif target.is_dir():
        files = sorted(p for p in target.glob("*.json") if p.name != "index.json")
        base = target
    else:
        print(f"not found: {target}")
        sys.exit(2)

    validated = []
    for p in files:
        d = validate_distributor(p)
        if d is not None:
            validated.append((p, d))

    index_path = base / "index.json"
    if index_path.exists():
        index_slugs = set(validate_index(index_path))
        file_slugs = {str(p.stem) for p, _ in validated}
        for s in sorted(file_slugs - index_slugs):
            warn(f"index.json: distributor '{s}' exists on disk but not indexed")
    else:
        warn(f"index.json: not found in {base}")

    print(f"Validated {len(validated)} distributor JSON file(s) in {base}")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    print(f"Result: {'PASS' if not errors else 'FAIL'} ({len(errors)} error(s), {len(warnings)} warning(s))")
    sys.exit(0 if not errors else 1)


if __name__ == "__main__":
    main()
