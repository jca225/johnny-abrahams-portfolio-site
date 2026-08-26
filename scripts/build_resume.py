#!/usr/bin/env -S uv run --with pyyaml,jinja2 python
"""Render profile/profile.yaml -> public/resume.pdf via LaTeX.

Usage: scripts/build_resume.py            (or: npm run resume)
Requires: uv (for pyyaml + jinja2) and pdflatex on PATH (MacTeX).
"""
import pathlib, re, shutil, subprocess, sys
import yaml, jinja2

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILE = ROOT / "profile" / "profile.yaml"
OUT_PDF = ROOT / "public" / "resume.pdf"
BUILD = ROOT / ".resume-build"

def tex(s):
    if s is None: return ""
    s = str(s)
    for a, b in [("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"), ("$", r"\$"),
                 ("#", r"\#"), ("_", r"\_"), ("{", r"\{"), ("}", r"\}"), ("~", r"\textasciitilde{}"),
                 ("^", r"\textasciicircum{}"), ("×", r"$\times$"), ("–", "--"), ("—", "--"),
                 ("’", "'"), ("‘", "`"), ("“", "``"), ("”", "''")]:
        s = s.replace(a, b)
    return s

def strip_scheme(u): return re.sub(r"^https?://(www\.)?", "", u)

def main():
    d = yaml.safe_load(PROFILE.read_text())
    by_id = {e["id"]: e for e in d["experience"]}
    limits = d["resume"].get("bullet_limit", {})
    exp = []
    for i in d["resume"]["experience_order"]:
        e = dict(by_id[i]); sel = limits.get(i)
        if isinstance(sel, int): e["bullets"] = e["bullets"][:sel]
        elif isinstance(sel, list): e["bullets"] = [e["bullets"][k] for k in sel]
        exp.append(e)
    pubs = [p for p in d.get("publications", []) if p.get("on_resume")] if d["resume"].get("include_publications") else []

    env = jinja2.Environment(
        block_start_string="<%", block_end_string="%>",
        variable_start_string="<<", variable_end_string=">>",
        comment_start_string="<#", comment_end_string="#>",
        trim_blocks=True, lstrip_blocks=True, autoescape=False,
    )
    env.filters["tex"] = tex; env.filters["strip_scheme"] = strip_scheme
    src = env.from_string((ROOT / "scripts" / "resume.tex.j2").read_text()).render(
        id=d["identity"], education=d["education"], skills=d["skills"],
        resume_experience=exp, resume_pubs=pubs)

    BUILD.mkdir(exist_ok=True)
    (BUILD / "resume.tex").write_text(src)
    r = subprocess.run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "resume.tex"],
                       cwd=BUILD, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-3000:]); sys.exit("pdflatex failed; see .resume-build/resume.log")
    shutil.copy(BUILD / "resume.pdf", OUT_PDF)
    pages = re.search(r"Output written on resume.pdf \((\d+) page", r.stdout)
    print(f"wrote {OUT_PDF.relative_to(ROOT)} ({pages.group(1) if pages else '?'} page(s))")

if __name__ == "__main__":
    main()
