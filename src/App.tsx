import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

import { hasSupabaseConfig, supabase } from "./supabaseClient";
import {
  cloudSignIn,
  cloudSignOut,
  cloudSignUp,
  getMyProfile,
  listProfilesAsMaster,
  loadScheduleFromCloud,
  masterResetPin,
  saveScheduleToCloud,
  type CloudSchedulePayload,
  type ProfileRow,
} from "./cloudSync";

/** ===== Types ===== */
type Day = "Mon" | "Tue" | "Wed" | "Thu" | "Fri";
type ClassType = "THEORY" | "LAB";
type Theme = "dark" | "light";
type ExportSkin = "default" | "lotr";

type SlotDef = {
  id: string;
  start: string; // "09:00"
  end: string; // "11:00"
  label: string; // "09:00–11:00"
};

type Course = {
  id: string;
  title: string;
  defaultRoom: string;
  defaultProfessors: string;
  courseUrl: string;
  createdAt: number;
};

type Entry = {
  id: string;
  courseId: string;
  day: Day;
  slotId: string;
  classType: ClassType;
  room: string; // optional override; if empty -> use course defaultRoom
  professors: string; // optional override; if empty -> use course defaultProfessors
  courseUrl: string; // optional override; if empty -> use course courseUrl
  createdAt: number;
};

/** ===== Constants ===== */
const DAYS: { key: Day; label: string }[] = [
  { key: "Mon", label: "Δευτέρα" },
  { key: "Tue", label: "Τρίτη" },
  { key: "Wed", label: "Τετάρτη" },
  { key: "Thu", label: "Πέμπτη" },
  { key: "Fri", label: "Παρασκευή" },
];

const DEFAULT_SLOTS: SlotDef[] = [
  { id: "09-11", start: "09:00", end: "11:00", label: "09:00–11:00" },
  { id: "11-13", start: "11:00", end: "13:00", label: "11:00–13:00" },
  { id: "14-16", start: "14:00", end: "16:00", label: "14:00–16:00" },
  { id: "16-18", start: "16:00", end: "18:00", label: "16:00–18:00" },
];

const SLOTS_KEY = "uni-schedule:slots:v1";
const COURSES_KEY = "uni-schedule:courses:v1";
const ENTRIES_KEY = "uni-schedule:entries:v1";
const THEME_KEY = "uni-schedule:theme:v1";
const EXPORT_SKIN_KEY = "uni-schedule:export-skin:v1";

/** Legacy keys (migration) */
const LEGACY_ENTRY_KEYS = ["uni-schedule:v3", "uni-schedule:v2", "uni-schedule:v1"];

/** ===== Helpers ===== */
function uid() {
  return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

function isHHMM(x: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
}

function isDay(x: any): x is Day {
  return x === "Mon" || x === "Tue" || x === "Wed" || x === "Thu" || x === "Fri";
}

function isClassType(x: any): x is ClassType {
  return x === "THEORY" || x === "LAB";
}

function dayLabel(d: Day) {
  return DAYS.find((x) => x.key === d)?.label ?? d;
}

function typeShort(t: ClassType) {
  return t === "THEORY" ? "Θ" : "Ε";
}

function slotLabel(slotId: string, slots: SlotDef[]) {
  return slots.find((s) => s.id === slotId)?.label ?? slotId;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeSlots(raw: any): SlotDef[] {
  if (!Array.isArray(raw)) return [];
  const out: SlotDef[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const id = typeof x.id === "string" ? x.id : "";
    const start = typeof x.start === "string" ? x.start : "";
    const end = typeof x.end === "string" ? x.end : "";
    const label = typeof x.label === "string" ? x.label : "";
    if (!id || !isHHMM(start) || !isHHMM(end)) continue;
    out.push({ id, start, end, label: label || `${start}–${end}` });
  }
  return out;
}

function normalizeCourses(raw: any): Course[] {
  if (!Array.isArray(raw)) return [];
  const out: Course[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const id = typeof x.id === "string" ? x.id : "";
    const title = typeof x.title === "string" ? x.title : "";
    const defaultRoom = typeof x.defaultRoom === "string" ? x.defaultRoom : "";
    const defaultProfessors = typeof x.defaultProfessors === "string" ? x.defaultProfessors : "";
    const courseUrl = typeof x.courseUrl === "string" ? x.courseUrl : "";
    const createdAt = typeof x.createdAt === "number" ? x.createdAt : Date.now();
    if (!id || !title.trim()) continue;
    out.push({ id, title: title.trim(), defaultRoom, defaultProfessors, courseUrl, createdAt });
  }
  return out;
}

function normalizeEntries(raw: any): Entry[] {
  if (!Array.isArray(raw)) return [];
  const out: Entry[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const id = typeof x.id === "string" ? x.id : "";
    const courseId = typeof x.courseId === "string" ? x.courseId : "";
    const day = (x as any).day;
    const slotId = typeof (x as any).slotId === "string" ? (x as any).slotId : "";
    const classType = (x as any).classType;
    const room = typeof (x as any).room === "string" ? (x as any).room : "";
    const professors = typeof (x as any).professors === "string" ? (x as any).professors : "";
    const courseUrl = typeof (x as any).courseUrl === "string" ? (x as any).courseUrl : "";
    const createdAt = typeof (x as any).createdAt === "number" ? (x as any).createdAt : Date.now();
    if (!id || !courseId || !isDay(day) || !slotId || !isClassType(classType)) continue;
    out.push({ id, courseId, day, slotId, classType, room, professors, courseUrl, createdAt });
  }
  return out;
}

function loadSlotsFromStorage(): { slots: SlotDef[]; isFirstTime: boolean } {
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    if (!raw) return { slots: DEFAULT_SLOTS, isFirstTime: true };
    const parsed = JSON.parse(raw);
    const slots = normalizeSlots(parsed);
    if (slots.length === 0) return { slots: DEFAULT_SLOTS, isFirstTime: true };
    return { slots, isFirstTime: false };
  } catch {
    return { slots: DEFAULT_SLOTS, isFirstTime: true };
  }
}

function loadCoursesFromStorage(): Course[] {
  try {
    const raw = localStorage.getItem(COURSES_KEY);
    if (!raw) return [];
    return normalizeCourses(JSON.parse(raw));
  } catch {
    return [];
  }
}

function loadEntriesFromStorage(): Entry[] {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    if (!raw) return [];
    return normalizeEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Legacy migration: old entries with title/day/slotId etc -> create courses + new entries */
function migrateLegacyIfNeeded(slots: SlotDef[]): { courses: Course[]; entries: Entry[] } {
  const existingCourses = loadCoursesFromStorage();
  const existingEntries = loadEntriesFromStorage();
  if (existingCourses.length > 0 || existingEntries.length > 0) {
    return { courses: existingCourses, entries: existingEntries };
  }

  for (const key of LEGACY_ENTRY_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;

      // old shape: {id,title,day,slotId, classType, room, professors, courseUrl, createdAt}
      const coursesMap = new Map<string, Course>();
      const entries: Entry[] = [];

      for (const x of data) {
        if (!x || typeof x !== "object") continue;

        const idOld = typeof (x as any).id === "string" ? (x as any).id : uid();
        const title = typeof (x as any).title === "string" ? (x as any).title.trim() : "";
        const day = (x as any).day;
        const classTypeRaw = (x as any).classType;
        const classType: ClassType = isClassType(classTypeRaw) ? classTypeRaw : "THEORY";

        const slotId =
          typeof (x as any).slotId === "string"
            ? (x as any).slotId
            : typeof (x as any).slot === "string"
              ? (x as any).slot
              : "";

        const room = typeof (x as any).room === "string" ? (x as any).room : "";
        const professors = typeof (x as any).professors === "string" ? (x as any).professors : "";
        const courseUrl = typeof (x as any).courseUrl === "string" ? (x as any).courseUrl : "";
        const createdAt = typeof (x as any).createdAt === "number" ? (x as any).createdAt : Date.now();

        if (!title || !isDay(day) || !slotId) continue;

        let course = coursesMap.get(title);
        if (!course) {
          course = {
            id: uid(),
            title,
            defaultRoom: room,
            defaultProfessors: professors,
            courseUrl,
            createdAt: Date.now(),
          };
          coursesMap.set(title, course);
        }

        entries.push({
          id: idOld,
          courseId: course.id,
          day,
          slotId,
          classType,
          room,
          professors,
          courseUrl,
          createdAt,
        });
      }

      const slotIds = new Set(slots.map((s) => s.id));
      const filtered = entries.filter((e) => slotIds.has(e.slotId));

      const courses = [...coursesMap.values()].sort((a, b) => a.title.localeCompare(b.title, "el"));
      localStorage.setItem(COURSES_KEY, JSON.stringify(courses));
      localStorage.setItem(ENTRIES_KEY, JSON.stringify(filtered));

      return { courses, entries: filtered };
    } catch {
      // try next legacy key
    }
  }

  return { courses: [], entries: [] };
}

function moveItemInsert<T>(arr: T[], fromIndex: number, insertIndex: number) {
  const copy = [...arr];
  const [item] = copy.splice(fromIndex, 1);
  let idx = insertIndex;
  if (fromIndex < idx) idx -= 1;
  if (idx < 0) idx = 0;
  if (idx > copy.length) idx = copy.length;
  copy.splice(idx, 0, item);
  return copy;
}

function buildCourseMap(courses: Course[]) {
  const m = new Map<string, Course>();
  for (const c of courses) m.set(c.id, c);
  return m;
}

function groupByCourse(entries: Entry[], courses: Course[], slots: SlotDef[]) {
  const courseMap = buildCourseMap(courses);
  const slotIdx = new Map<string, number>();
  slots.forEach((s, i) => slotIdx.set(s.id, i));
  const dayOrder = (d: Day) => DAYS.findIndex((x) => x.key === d);
  const slotOrder = (slotId: string) => slotIdx.get(slotId) ?? 9999;

  const map = new Map<string, { course: Course; sessions: Entry[] }>();
  for (const e of entries) {
    const c = courseMap.get(e.courseId);
    if (!c) continue;
    if (!map.has(c.id)) map.set(c.id, { course: c, sessions: [] });
    map.get(c.id)!.sessions.push(e);
  }

  const groups = [...map.values()].map((g) => {
    g.sessions.sort((a, b) => {
      const dd = dayOrder(a.day) - dayOrder(b.day);
      if (dd !== 0) return dd;
      return slotOrder(a.slotId) - slotOrder(b.slotId);
    });
    return g;
  });

  groups.sort((a, b) => a.course.title.localeCompare(b.course.title, "el"));
  return groups;
}

/** ===== Export HTML (table scroll + list + embedded backup + theme toggle) ===== */
function buildExportHtml(
  slots: SlotDef[],
  courses: Course[],
  entries: Entry[],
  theme: Theme,
  skin: ExportSkin
) {
  const courseMap = buildCourseMap(courses);

  const byKey = new Map<string, Entry>();
  for (const e of entries) byKey.set(`${e.day}__${e.slotId}`, e);

  const tableRows = slots
    .map((slot) => {
      const cells = DAYS.map((day) => {
        const e = byKey.get(`${day.key}__${slot.id}`);
        if (!e) return `<td class="cell empty"></td>`;

        const c = courseMap.get(e.courseId);
        const title = c?.title ?? "—";
        const effRoom = (e.room || c?.defaultRoom || "").trim() || "—";

        return `
          <td class="cell">
            <div class="cellTitle">${escapeHtml(title)}</div>
            <div class="cellMeta">
              <span class="badge">${typeShort(e.classType)}</span>
              <span class="room">${escapeHtml(effRoom)}</span>
            </div>
          </td>
        `;
      }).join("");

      return `
        <tr>
          <th class="rowHead">${escapeHtml(slot.label)}</th>
          ${cells}
        </tr>
      `;
    })
    .join("");

  const groups = groupByCourse(entries, courses, slots);

  const listItems = groups
    .map(({ course, sessions }) => {
      const profPart = course.defaultProfessors?.trim()
        ? escapeHtml(course.defaultProfessors.trim())
        : "—";
      const urlPart = course.courseUrl?.trim()
        ? `<a href="${escapeHtml(course.courseUrl.trim())}" target="_blank" rel="noreferrer">${escapeHtml(
            course.courseUrl.trim()
          )}</a>`
        : `<span class="muted">—</span>`;

      const sessionsHtml = sessions
        .map((s) => {
          const effRoom = (s.room || course.defaultRoom || "").trim() || "—";
          return `
            <div class="sessionRow">
              <span>${escapeHtml(dayLabel(s.day))} — ${escapeHtml(slotLabel(s.slotId, slots))}</span>
              <span class="badge">${typeShort(s.classType)}</span>
              <span class="room">${escapeHtml(effRoom)}</span>
            </div>
          `;
        })
        .join("");

      return `
        <li class="li">
          <div class="liTitle">${escapeHtml(course.title)}</div>
          <div class="liMeta"><b>Καθηγητές:</b> ${profPart}</div>
          <div class="liMeta"><b>Σελίδα μαθήματος:</b> ${urlPart}</div>
          <div class="liMeta"><b>Ώρες/slots:</b></div>
          ${sessionsHtml || `<div class="muted">—</div>`}
        </li>
      `;
    })
    .join("");

  const backup = {
    app: "uni-schedule",
    version: 1,
    exportedAt: Date.now(),
    theme,
    skin,
    data: { slots, courses, entries },
  };
  const backupJson = JSON.stringify(backup).replace(/</g, "\\u003c");
  const now = new Date().toLocaleString("el-GR");

  // DEFAULT export CSS (μένει όπως ήταν – dark/rocky-ish)
  const EXPORT_CSS_DEFAULT = `
:root{
  --cyan:#22d3ee;
  --pink:#ff2d55;
  --purple:#7c3aed;
  --shadow: 0 14px 42px rgba(0,0,0,.60);
}
html[data-theme="dark"]{
  color-scheme: dark;
  --bg0:#05070b;
  --bg1:#0b1020;
  --text:#e5e7eb;
  --muted:#94a3b8;
  --border: rgba(255,255,255,.10);
  --card: rgba(8,12,22,.78);
  --card2: rgba(8,12,22,.68);
  --empty: rgba(8,12,22,.35);
  --dash: rgba(148,163,184,.25);
  --btn: rgba(15,23,42,.75);
}
html[data-theme="light"]{
  color-scheme: light;
  --bg0:#f8fafc;
  --bg1:#eef2ff;
  --text:#0f172a;
  --muted:#475569;
  --border: rgba(15,23,42,.12);
  --card: rgba(255,255,255,.88);
  --card2: rgba(255,255,255,.75);
  --empty: rgba(255,255,255,.55);
  --dash: rgba(15,23,42,.18);
  --btn: rgba(255,255,255,.92);
  --shadow: 0 14px 42px rgba(2,6,23,.10);
}
body{
  font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
  margin:18px;
  color:var(--text);
  background:
    radial-gradient(900px 520px at 10% 0%, rgba(124,58,237,.18), transparent 58%),
    radial-gradient(780px 480px at 90% 10%, rgba(255,45,85,.14), transparent 58%),
    radial-gradient(920px 640px at 50% 120%, rgba(34,211,238,.08), transparent 58%),
    linear-gradient(180deg, var(--bg0), var(--bg1));
}
.wrap{max-width:1100px; margin:0 auto;}
h1{margin:0 0 6px; font-size:22px; letter-spacing:.3px;}
.sub{color:var(--muted); margin-bottom:14px; font-size:13px;}

.topBar{display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px;}
.tbtn{
  border:1px solid var(--border);
  background: var(--btn);
  color: var(--text);
  padding:10px 12px;
  border-radius:12px;
  cursor:pointer;
  font-weight:900;
}
.tbtn:hover{ border-color: rgba(34,211,238,.35); }

.tableScroll{overflow:auto; -webkit-overflow-scrolling: touch; padding-bottom:6px;}
table{width:100%; border-collapse:separate; border-spacing:10px; table-layout:fixed; min-width:860px;}
th, td{vertical-align:top;}
.colHead,.rowHead{
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color:var(--muted);
}
.colHead{font-size:12.5px; text-align:left; padding-left:4px;}
.rowHead{font-size:12px; text-align:right; padding-right:6px; width:140px;}

.cell{background: var(--card); border:1px solid var(--border); border-radius:16px; padding:10px; min-height:68px; box-shadow: var(--shadow);}
.empty{background: var(--empty); border:1px dashed var(--dash); box-shadow:none;}
.cellTitle{font-weight:900; font-size:13px; margin-bottom:6px; letter-spacing:.2px;}
.cellMeta{display:flex; gap:8px; align-items:center; font-size:12px; color: color-mix(in srgb, var(--text) 80%, var(--muted));}

hr{border:none; border-top:1px solid color-mix(in srgb, var(--border) 70%, transparent); margin:18px 0;}
ul{list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:10px;}
.li{background: var(--card2); border:1px solid var(--border); border-radius:16px; padding:12px; box-shadow: var(--shadow); break-inside: avoid;}
.liTitle{font-weight:950; margin-bottom:6px; letter-spacing:.2px;}
.liMeta{font-size:13px; color: color-mix(in srgb, var(--text) 82%, var(--muted)); margin-top:6px;}
.muted{color:var(--muted);}
a{color: var(--cyan); text-decoration:none;}
a:hover{text-decoration:underline;}
.sessionRow{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; padding-top:8px; border-top:1px solid color-mix(in srgb, var(--border) 70%, transparent); break-inside: avoid;}
.badge{display:inline-flex; align-items:center; justify-content:center; padding:2px 8px; border-radius:999px; border:1px solid color-mix(in srgb, var(--border) 90%, transparent); background: color-mix(in srgb, var(--btn) 85%, transparent); font-weight:950; font-size:12px;}
.room{opacity:.9;}
`;

  // LOTR export CSS (μόνο για export)
  const EXPORT_CSS_LOTR = `
:root{
  --gold:#d4af37;
  --olive:#2f3b2f;
  --ink:#1e1a12;
  --shadow: 0 18px 46px rgba(0,0,0,.35);
}
html[data-theme="dark"]{
  color-scheme: dark;
  --bg0:#070a06;
  --bg1:#10140e;
  --text:#efe7d6;
  --muted:#b9b0a0;

  --border: rgba(212,175,55,.22);
  --dash: rgba(185,176,160,.22);

  --card: rgba(20,26,18,.76);
  --card2: rgba(20,26,18,.62);
  --empty: rgba(20,26,18,.34);

  --btn: rgba(20,26,18,.72);
}
html[data-theme="light"]{
  color-scheme: light;
  --bg0:#fbf2dc;
  --bg1:#f1e5c4;
  --text:#1e1a12;
  --muted:#5b5246;

  --border: rgba(47,59,47,.22);
  --dash: rgba(30,26,18,.16);

  --card: rgba(255,255,255,.78);
  --card2: rgba(255,255,255,.66);
  --empty: rgba(255,255,255,.52);

  --btn: rgba(255,255,255,.90);
}
body{
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  margin:18px;
  color:var(--text);
  background:
    radial-gradient(900px 520px at 12% 0%, rgba(212,175,55,.10), transparent 58%),
    radial-gradient(800px 520px at 88% 8%, rgba(47,59,47,.12), transparent 60%),
    linear-gradient(180deg, var(--bg0), var(--bg1));
}
body::after{
  content:"";
  position: fixed;
  inset:0;
  pointer-events:none;
  opacity:.10;
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E");
  mix-blend-mode: multiply;
}
.wrap{max-width:1100px; margin:0 auto;}
h1{margin:0 0 6px; font-size:22px; letter-spacing:.6px; font-weight:900;}
.sub{color:var(--muted); margin-bottom:14px; font-size:13px;}

.topBar{display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px;}
.tbtn{
  border:1px solid var(--border);
  background: var(--btn);
  color: var(--text);
  padding:10px 12px;
  border-radius:14px;
  cursor:pointer;
  font-weight:900;
}
.tbtn:hover{border-color: rgba(212,175,55,.45);}

.tableScroll{overflow:auto; -webkit-overflow-scrolling: touch; padding-bottom:6px;}
table{width:100%; border-collapse:separate; border-spacing:10px; table-layout:fixed; min-width:860px;}
th, td{vertical-align:top;}
.colHead,.rowHead{
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color:var(--muted);
}
.colHead{font-size:12.5px; text-align:left; padding-left:4px;}
.rowHead{font-size:12px; text-align:right; padding-right:6px; width:140px;}

.cell{
  border-radius:18px;
  padding:10px;
  min-height:68px;
  border:1px solid var(--border);
  background:
    radial-gradient(220px 120px at 20% 10%, rgba(212,175,55,.10), transparent 55%),
    linear-gradient(180deg, var(--card), rgba(0,0,0,0));
  box-shadow: var(--shadow);
}
.empty{
  background: var(--empty);
  border:1px dashed var(--dash);
  box-shadow:none;
}
.cellTitle{font-weight:900; font-size:13px; margin-bottom:6px; letter-spacing:.25px;}
.cellMeta{display:flex; gap:8px; align-items:center; font-size:12px; color: color-mix(in srgb, var(--text) 80%, var(--muted));}
.badge{
  display:inline-flex; align-items:center; justify-content:center;
  padding:2px 8px; border-radius:999px;
  border:1px solid var(--border);
  background: rgba(212,175,55,.10);
  font-weight:900; font-size:12px;
}
.room{opacity:.9;}

hr{border:none; border-top:1px solid rgba(212,175,55,.18); margin:18px 0;}
ul{list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:10px;}
.li{background: var(--card2); border:1px solid var(--border); border-radius:18px; padding:12px; box-shadow: var(--shadow); break-inside: avoid;}
.liTitle{font-weight:900; margin-bottom:6px; letter-spacing:.25px;}
.liMeta{font-size:13px; color: color-mix(in srgb, var(--text) 82%, var(--muted)); margin-top:6px;}
.muted{color:var(--muted);}
a{color: var(--olive); text-decoration:none; font-weight:800;}
a:hover{text-decoration:underline;}
.sessionRow{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; padding-top:8px; border-top:1px solid rgba(212,175,55,.14); break-inside: avoid;}
`;

  const exportCss = skin === "lotr" ? EXPORT_CSS_LOTR : EXPORT_CSS_DEFAULT;

  return `<!doctype html>
<html lang="el" data-theme="${theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Εβδομαδιαίο Πρόγραμμα</title>
  <style>
${exportCss}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topBar">
      <div>
        <h1>Εβδομαδιαίο Πρόγραμμα</h1>
        <div class="sub">Παραγωγή: ${escapeHtml(now)}</div>
      </div>
      <button id="themeToggle" class="tbtn" type="button">Toggle</button>
    </div>

    <div class="tableScroll">
      <table>
        <thead>
          <tr>
            <th></th>
            ${DAYS.map((d) => `<th class="colHead">${escapeHtml(d.label)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <hr />

    <h1>Λίστα μαθημάτων</h1>
    <div class="sub">Ομαδοποιημένα ανά μάθημα</div>

    <ul>
      ${listItems || `<li class="li"><span class="muted">Δεν υπάρχουν καταχωρήσεις.</span></li>`}
    </ul>
  </div>

  <!-- Embedded backup (for restore inside the app) -->
  <script id="uniScheduleBackup" type="application/json">${backupJson}</script>

  <script>
  (function(){
    const KEY = "${THEME_KEY}";
    const root = document.documentElement;

    function apply(t){
      root.setAttribute("data-theme", t);
      root.style.colorScheme = t;
      const btn = document.getElementById("themeToggle");
      if(btn) btn.textContent = (t === "dark") ? "Light mode" : "Dark mode";
    }

    const saved = localStorage.getItem(KEY);
    const initial =
      (saved === "light" || saved === "dark")
        ? saved
        : (root.getAttribute("data-theme") || "dark");

    apply(initial);

    const btn = document.getElementById("themeToggle");
    if(btn){
      btn.addEventListener("click", function(){
        const cur = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
        const next = (cur === "dark") ? "light" : "dark";
        localStorage.setItem(KEY, next);
        apply(next);
      });
    }
  })();
  </script>
</body>
</html>`;
}

/** ===== App ===== */
export default function App() {
  /** Cloud (Supabase) */
  const cloudEnabled = hasSupabaseConfig && !!supabase;
  const [authReady, setAuthReady] = useState<boolean>(() => !cloudEnabled);
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);

  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authUsername, setAuthUsername] = useState<string>("");
  const [authPin, setAuthPin] = useState<string>("");
  const [authError, setAuthError] = useState<string>("");

  const [cloudBusy, setCloudBusy] = useState<boolean>(false);
  const [cloudDirty, setCloudDirty] = useState<boolean>(false);
  const [cloudLastSavedAt, setCloudLastSavedAt] = useState<string | null>(null);
  const [cloudBanner, setCloudBanner] = useState<string>("");

  const [showMasterPanel, setShowMasterPanel] = useState<boolean>(false);
  const [masterRows, setMasterRows] = useState<ProfileRow[] | null>(null);

  const hydratingRef = useRef<boolean>(true);

  /** Theme */
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
    return prefersLight ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    (document.documentElement as any).style.colorScheme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  /** Export skin (μόνο για export HTML) */
  const [exportSkin, setExportSkin] = useState<ExportSkin>(() => {
    const saved = localStorage.getItem(EXPORT_SKIN_KEY);
    return saved === "lotr" ? "lotr" : "default";
  });
  useEffect(() => {
    localStorage.setItem(EXPORT_SKIN_KEY, exportSkin);
  }, [exportSkin]);

  const [init] = useState(() => {
    const s = loadSlotsFromStorage();
    const mig = migrateLegacyIfNeeded(s.slots);
    const courses = mig.courses;
    const entries = mig.entries;

    return {
      slots: s.slots,
      showSlotsSetup: s.isFirstTime,
      courses,
      entries,
      showCoursesSetup: courses.length === 0,
    };
  });

  const [slots, setSlots] = useState<SlotDef[]>(init.slots);
  const [courses, setCourses] = useState<Course[]>(init.courses);
  const [entries, setEntries] = useState<Entry[]>(init.entries);

  const [showSlotsSetup, setShowSlotsSetup] = useState<boolean>(init.showSlotsSetup);
  const [showCoursesSetup, setShowCoursesSetup] = useState<boolean>(init.showCoursesSetup);

  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  // ===== Cloud auth/session bootstrap =====
  useEffect(() => {
    if (!cloudEnabled || !supabase) {
      setAuthReady(true);
      return;
    }

    let alive = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!alive) return;
        setUserId(data.session?.user?.id ?? null);
        setAuthReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setUserId(null);
        setAuthReady(true);
      });

    const { data } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUserId(session?.user?.id ?? null);
    });

    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [cloudEnabled]);

  // Drag reorder state for sessions
  const [draggingSlotId, setDraggingSlotId] = useState<string | null>(null);
  const lastInsertRef = useRef<string>("");

  // Persist
  useEffect(() => {
    const k = userId ? `${SLOTS_KEY}:${userId}` : SLOTS_KEY;
    localStorage.setItem(k, JSON.stringify(slots));
  }, [slots, userId]);

  useEffect(() => {
    const k = userId ? `${COURSES_KEY}:${userId}` : COURSES_KEY;
    localStorage.setItem(k, JSON.stringify(courses));
  }, [courses, userId]);

  useEffect(() => {
    const k = userId ? `${ENTRIES_KEY}:${userId}` : ENTRIES_KEY;
    localStorage.setItem(k, JSON.stringify(entries));
  }, [entries, userId]);

  // Mark dirty (manual save mode) whenever schedule changes after initial hydration
  useEffect(() => {
    if (!cloudEnabled || !userId) return;
    if (hydratingRef.current) return;
    setCloudDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, courses, entries, theme, exportSkin, cloudEnabled, userId]);

  // Load profile + schedule from cloud when logged in
  useEffect(() => {
    if (!cloudEnabled) return;

    // Signed out
    if (!userId) {
      setProfile(null);
      setCloudDirty(false);
      setCloudLastSavedAt(null);
      setCloudBanner("");
      setShowMasterPanel(false);
      setMasterRows(null);
      hydratingRef.current = true;
      return;
    }

    let alive = true;

    (async () => {
      setCloudBusy(true);
      setCloudBanner("Φόρτωση από Cloud…");
      setAuthError("");

      try {
        // Profile (username + is_master)
        const p = await getMyProfile(userId).catch(() => null);
        if (!alive) return;
        setProfile(p);

        // Schedule data
        const cloud = await loadScheduleFromCloud(userId).catch(() => null);
        if (!alive) return;

        const applyPayload = (payload: any) => {
          const slotsN = normalizeSlots(payload?.slots);
          const coursesN = normalizeCourses(payload?.courses);
          const entriesN = normalizeEntries(payload?.entries);

          // slots are mandatory for a valid schedule
          if (slotsN.length > 0) {
            const slotIds = new Set(slotsN.map((s) => s.id));
            const courseIds = new Set(coursesN.map((c) => c.id));
            const entriesFiltered = entriesN.filter((e) => slotIds.has(e.slotId) && courseIds.has(e.courseId));

            hydratingRef.current = true;
            setSlots(slotsN);
            setCourses(coursesN);
            setEntries(entriesFiltered);
            setShowSlotsSetup(false);
            setShowCoursesSetup(coursesN.length === 0);
            setTimeout(() => {
              hydratingRef.current = false;
            }, 0);
          }
        };

        // Prefer cloud
        if (cloud?.data) {
          const payload = cloud.data as any;

          if (payload.theme === "dark" || payload.theme === "light") setTheme(payload.theme);
          if (payload.exportSkin === "default" || payload.exportSkin === "lotr") setExportSkin(payload.exportSkin);

          applyPayload(payload);
          setCloudLastSavedAt(cloud.updated_at ?? null);
          setCloudDirty(false);
          setCloudBanner("Φορτώθηκε ✅");
          return;
        }

        // No cloud data yet -> try scoped local cache
        try {
          const slotsRaw = localStorage.getItem(`${SLOTS_KEY}:${userId}`);
          const coursesRaw = localStorage.getItem(`${COURSES_KEY}:${userId}`);
          const entriesRaw = localStorage.getItem(`${ENTRIES_KEY}:${userId}`);
          if (slotsRaw || coursesRaw || entriesRaw) {
            const payload = {
              slots: slotsRaw ? JSON.parse(slotsRaw) : [],
              courses: coursesRaw ? JSON.parse(coursesRaw) : [],
              entries: entriesRaw ? JSON.parse(entriesRaw) : [],
            };
            applyPayload(payload);
          }
        } catch {
          // ignore
        }

        setCloudLastSavedAt(null);
        setCloudDirty(false);
        setCloudBanner("Χωρίς cloud δεδομένα — κάνε Import ή πάτα Save.");
      } catch (e: any) {
        if (!alive) return;
        setCloudBanner("Σφάλμα φόρτωσης cloud. Θα δουλέψεις τοπικά.");
      } finally {
        if (!alive) return;
        setCloudBusy(false);
        // In case nothing called applyPayload (no cloud + no local cache), stop considering ourselves "hydrating".
        setTimeout(() => {
          if (alive) hydratingRef.current = false;
        }, 0);
        setTimeout(() => {
          if (alive) setCloudBanner("");
        }, 2500);
      }
    })();

    return () => {
      alive = false;
    };
  }, [cloudEnabled, userId]);

  const courseMap = useMemo(() => buildCourseMap(courses), [courses]);

  const slotMap = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of entries) m.set(`${e.day}__${e.slotId}`, e);
    return m;
  }, [entries]);

  const groups = useMemo(() => groupByCourse(entries, courses, slots), [entries, courses, slots]);

  // ===== Schedule form (place course into a slot) =====
  const [form, setForm] = useState({
    courseId: courses[0]?.id ?? "",
    day: "Mon" as Day,
    slotId: slots[0]?.id ?? DEFAULT_SLOTS[0].id,
    classType: "THEORY" as ClassType,
    room: "",
    professors: "",
    courseUrl: "",
  });

  // Ensure form slot exists
  useEffect(() => {
    if (slots.length === 0) return;
    if (!slots.some((s) => s.id === form.slotId)) {
      setForm((p) => ({ ...p, slotId: slots[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots]);

  // If course list changes, keep a valid selection
  useEffect(() => {
    if (courses.length === 0) {
      setForm((p) => ({ ...p, courseId: "" }));
      return;
    }
    if (!courses.some((c) => c.id === form.courseId)) {
      setForm((p) => ({ ...p, courseId: courses[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses]);

  // When course selection changes, preload defaults into fields
  useEffect(() => {
    if (!form.courseId) return;
    const c = courseMap.get(form.courseId);
    if (!c) return;

    setForm((p) => ({
      ...p,
      room: c.defaultRoom || "",
      professors: c.defaultProfessors || "",
      courseUrl: c.courseUrl || "",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.courseId]);

  function effectiveRoom(e: Entry, c: Course | undefined) {
    return (e.room || c?.defaultRoom || "").trim() || "—";
  }

  function setDaySlot(day: Day, slotId: string) {
    const existing = slotMap.get(`${day}__${slotId}`);
    if (existing) {
      const c = courseMap.get(existing.courseId);
      setForm({
        courseId: existing.courseId,
        day,
        slotId,
        classType: existing.classType,
        room: existing.room || c?.defaultRoom || "",
        professors: existing.professors || c?.defaultProfessors || "",
        courseUrl: existing.courseUrl || c?.courseUrl || "",
      });
    } else {
      setForm((prev) => ({ ...prev, day, slotId }));
    }
  }

  function upsertEntry() {
    if (!form.courseId) return alert("Πρόσθεσε πρώτα ένα μάθημα (Courses) και επέλεξέ το.");
    if (slots.length === 0) return alert("Πρόσθεσε πρώτα sessions/ώρες.");

    const key = `${form.day}__${form.slotId}`;
    const existing = slotMap.get(key);

    const newEntry: Entry = {
      id: existing?.id ?? uid(),
      courseId: form.courseId,
      day: form.day,
      slotId: form.slotId,
      classType: form.classType,
      room: form.room.trim(),
      professors: form.professors.trim(),
      courseUrl: form.courseUrl.trim(),
      createdAt: existing?.createdAt ?? Date.now(),
    };

    if (existing) {
      const oldCourse = courseMap.get(existing.courseId)?.title ?? "—";
      const newCourse = courseMap.get(form.courseId)?.title ?? "—";

      const ok = confirm(
        `Το slot ${dayLabel(form.day)} ${slotLabel(form.slotId, slots)} είναι ήδη πιασμένο από "${oldCourse}".\n\nΘες αντικατάσταση με "${newCourse}";`
      );
      if (!ok) return;

      setEntries((prev) => prev.map((e) => (e.id === existing.id ? newEntry : e)));
      return;
    }

    setEntries((prev) => [...prev, newEntry]);
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function clearAll() {
    const ok = confirm("Σίγουρα θες να διαγράψεις όλες τις καταχωρήσεις του προγράμματος;");
    if (!ok) return;
    setEntries([]);
  }

  // ===== Cloud actions (manual save) =====
  async function saveToCloud() {
    if (!cloudEnabled || !userId) {
      alert("Δεν είσαι συνδεδεμένος στο Cloud.");
      return;
    }

    try {
      setCloudBusy(true);
      setCloudBanner("Αποθήκευση στο Cloud…");

      const payload: CloudSchedulePayload = {
        slots,
        courses,
        entries,
        theme,
        exportSkin,
      };

      const res = await saveScheduleToCloud(userId, payload);
      setCloudLastSavedAt(res.updated_at);
      setCloudDirty(false);
      setCloudBanner("Saved ✅");
    } catch (e: any) {
      const msg = e?.message || "Αποτυχία αποθήκευσης.";
      alert(`Σφάλμα Cloud: ${msg}`);
      setCloudBanner("Σφάλμα αποθήκευσης ❌");
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudBanner(""), 2000);
    }
  }

  async function signOutCloud() {
    if (!cloudEnabled) return;
    await cloudSignOut();
    setAuthUsername("");
    setAuthPin("");
    setAuthError("");
  }

  async function openMaster() {
    if (!cloudEnabled || !profile?.is_master) return;
    setShowMasterPanel(true);
    try {
      setCloudBusy(true);
      const rows = await listProfilesAsMaster();
      setMasterRows(rows);
    } catch (e: any) {
      alert(`Σφάλμα Master panel: ${e?.message || "unknown"}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function doMasterResetPin(username: string) {
    if (!cloudEnabled || !profile?.is_master) return;

    const newPin = prompt(`Νέο ΠΡΟΣΩΡΙΝΟ PIN για τον χρήστη: ${username}\n(π.χ. 4–12 ψηφία)`);
    if (!newPin) return;
    if (!/^\d{4,12}$/.test(newPin)) {
      alert("PIN πρέπει να είναι 4–12 ψηφία.");
      return;
    }

    try {
      setCloudBusy(true);
      const res = await masterResetPin(username, newPin);
      if (res?.ok) {
        alert(`OK ✅\nΟ χρήστης ${username} μπορεί τώρα να συνδεθεί με το νέο PIN.`);
      } else {
        alert(`Αποτυχία: ${res?.message || "unknown"}`);
      }
    } catch (e: any) {
      alert(`Σφάλμα reset-pin: ${e?.message || "unknown"}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function submitAuth() {
    if (!cloudEnabled) return;

    const u = authUsername.trim();
    const pin = authPin.trim();
    if (!u) return setAuthError("Βάλε username.");
    if (!/^\d{4,12}$/.test(pin)) return setAuthError("PIN: 4–12 ψηφία.");

    // Reserve some usernames for safety
    const lower = u.toLowerCase();
    if (authMode === "signup" && (lower === "admin" || lower === "root")) {
      return setAuthError("Αυτό το username είναι δεσμευμένο.");
    }

    setAuthError("");
    try {
      setCloudBusy(true);
      setCloudBanner(authMode === "signup" ? "Δημιουργία χρήστη…" : "Σύνδεση…");

      if (authMode === "signup") {
        const res = await cloudSignUp(u, pin);
        // If email confirmation is ON, session may be null
        if (!res.session) {
          // try sign in anyway (works when email confirmation is OFF)
          await cloudSignIn(u, pin);
        }
      } else {
        await cloudSignIn(u, pin);
      }
    } catch (e: any) {
      setAuthError(e?.message || "Σφάλμα σύνδεσης/δημιουργίας χρήστη.");
    } finally {
      setCloudBusy(false);
      setCloudBanner("");
    }
  }

  function openExportPreview() {
    const html = buildExportHtml(slots, courses, entries, theme, exportSkin);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const w = window.open(url, "_blank");
    if (!w) {
      URL.revokeObjectURL(url);
      return alert("Ο browser μπλόκαρε το νέο tab. Επίτρεψέ το και ξαναδοκίμασε.");
    }

    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  function downloadExportHtml() {
    const html = buildExportHtml(slots, courses, entries, theme, exportSkin);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "programma.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function restoreFromHtmlFile(file: File) {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    const script = doc.getElementById("uniScheduleBackup");

    if (!script) {
      alert("Δεν βρέθηκε backup μέσα στο HTML.\nΦρόντισε να είναι export από αυτή την εφαρμογή (programma.html).");
      return;
    }

    const jsonText = script.textContent?.trim() ?? "";
    if (!jsonText) {
      alert("Το backup μέσα στο HTML είναι κενό ή κατεστραμμένο.");
      return;
    }

    let backup: any;
    try {
      backup = JSON.parse(jsonText);
    } catch {
      alert("Το backup JSON μέσα στο HTML δεν είναι έγκυρο.");
      return;
    }

    if (!backup || backup.app !== "uni-schedule" || !backup.data) {
      alert("Το HTML δεν φαίνεται να είναι σωστό export της εφαρμογής.");
      return;
    }

    if (backup.theme === "light" || backup.theme === "dark") {
      setTheme(backup.theme);
    }
    if (backup.skin === "lotr" || backup.skin === "default") {
      setExportSkin(backup.skin);
    }

    const slotsN = normalizeSlots(backup.data.slots);
    const coursesN = normalizeCourses(backup.data.courses);
    const entriesN = normalizeEntries(backup.data.entries);

    if (slotsN.length === 0) {
      alert("Το backup δεν έχει sessions/ώρες. Δεν μπορεί να γίνει επαναφορά.");
      return;
    }

    const slotIds = new Set(slotsN.map((s) => s.id));
    const courseIds = new Set(coursesN.map((c) => c.id));
    const entriesFiltered = entriesN.filter((e) => slotIds.has(e.slotId) && courseIds.has(e.courseId));

    const exportedAt =
      typeof backup.exportedAt === "number" ? new Date(backup.exportedAt).toLocaleString("el-GR") : "άγνωστο";

    const ok = confirm(
      `Θα γίνει ΕΠΑΝΑΦΟΡΑ από HTML backup.\n\nΗμερομηνία export: ${exportedAt}\n\nΘες να αντικατασταθούν τα τωρινά δεδομένα;`
    );
    if (!ok) return;

    setSlots(slotsN);
    setCourses(coursesN);
    setEntries(entriesFiltered);

    setShowSlotsSetup(false);
    setShowCoursesSetup(coursesN.length === 0);

    alert("Η επαναφορά ολοκληρώθηκε ✅");
  }

  // ===== Sessions drag reorder (pointer-based) =====
  useEffect(() => {
    if (!draggingSlotId) return;

    const onMove = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const row = el?.closest("[data-slot-row='true']") as HTMLElement | null;
      if (!row) return;

      const targetId = row.getAttribute("data-id") || "";
      if (!targetId || targetId === draggingSlotId) return;

      const rect = row.getBoundingClientRect();
      const insertAfter = ev.clientY > rect.top + rect.height / 2;

      const signature = `${draggingSlotId}->${targetId}:${insertAfter ? "A" : "B"}`;
      if (lastInsertRef.current === signature) return;
      lastInsertRef.current = signature;

      setSlots((prev) => {
        const from = prev.findIndex((s) => s.id === draggingSlotId);
        const t = prev.findIndex((s) => s.id === targetId);
        if (from < 0 || t < 0) return prev;

        const ins = insertAfter ? t + 1 : t;
        return moveItemInsert(prev, from, ins);
      });
    };

    const onUp = () => {
      setDraggingSlotId(null);
      lastInsertRef.current = "";
      document.body.classList.remove("noSelect");
    };

    document.body.classList.add("noSelect");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("noSelect");
    };
  }, [draggingSlotId]);

  function recomputeLabel(start: string, end: string) {
    return `${start}–${end}`;
  }

  function addSlot() {
    const id = uid();
    setSlots((prev) => [...prev, { id, start: "09:00", end: "10:00", label: "09:00–10:00" }]);
  }

  function updateSlot(id: string, patch: Partial<SlotDef>) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function deleteSlot(id: string) {
    const slotUsed = entries.some((e) => e.slotId === id);
    const msg = slotUsed
      ? "Αυτό το session χρησιμοποιείται σε καταχωρήσεις. Αν το σβήσεις, θα σβηστούν και οι αντίστοιχες καταχωρήσεις.\n\nΣυνέχεια;"
      : "Σίγουρα θες να διαγράψεις αυτό το session;";
    const ok = confirm(msg);
    if (!ok) return;

    setSlots((prev) => prev.filter((s) => s.id !== id));
    setEntries((prev) => prev.filter((e) => e.slotId !== id));
  }

  // ===== Courses management =====
  function addCourse() {
    const c: Course = {
      id: uid(),
      title: "Νέο μάθημα",
      defaultRoom: "",
      defaultProfessors: "",
      courseUrl: "",
      createdAt: Date.now(),
    };
    setCourses((prev) => [...prev, c]);
    if (!form.courseId) setForm((p) => ({ ...p, courseId: c.id }));
  }

  function updateCourse(id: string, patch: Partial<Course>) {
    setCourses((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const nextTitle = (patch.title ?? c.title).trim();
        return { ...c, ...patch, title: nextTitle };
      })
    );
  }

  function deleteCourse(id: string) {
    const used = entries.some((e) => e.courseId === id);
    const msg = used
      ? "Αυτό το μάθημα χρησιμοποιείται σε καταχωρήσεις. Αν το σβήσεις, θα σβηστούν και οι αντίστοιχες καταχωρήσεις.\n\nΣυνέχεια;"
      : "Σίγουρα θες να διαγράψεις αυτό το μάθημα;";
    const ok = confirm(msg);
    if (!ok) return;

    setCourses((prev) => prev.filter((c) => c.id !== id));
    setEntries((prev) => prev.filter((e) => e.courseId !== id));

    if (form.courseId === id) {
      const next = courses.find((c) => c.id !== id);
      setForm((p) => ({ ...p, courseId: next?.id ?? "" }));
    }
  }

  /** ===== Cloud Login Gate ===== */
  if (cloudEnabled) {
    if (!authReady) {
      return (
        <div className="page">
          <header className="header">
            <div className="headerRow">
              <h1>Uni Schedule — Cloud</h1>
              <button className="btn themeBtn" onClick={toggleTheme}>
                {theme === "dark" ? "Light" : "Dark"}
              </button>
            </div>
            <div className="sub">Έλεγχος σύνδεσης…</div>
          </header>
        </div>
      );
    }

    if (!userId) {
      return (
        <div className="page">
          <header className="header">
            <div className="headerRow">
              <h1>Uni Schedule — Είσοδος</h1>
              <button className="btn themeBtn" onClick={toggleTheme}>
                {theme === "dark" ? "Light" : "Dark"}
              </button>
            </div>
            <div className="sub">
              Συνδέσου (ή δημιούργησε χρήστη) για να συγχρονίζονται τα δεδομένα σε όλες τις συσκευές.
            </div>
          </header>

          <div className="layout">
            <section className="panel panelFull">
              <h2>{authMode === "signin" ? "Σύνδεση" : "Δημιουργία χρήστη"}</h2>

              <div className="formGrid">
                <label>
                  Username
                  <input
                    value={authUsername}
                    onChange={(e) => setAuthUsername(e.target.value)}
                    placeholder="π.χ. thanasis"
                    autoComplete="username"
                  />
                </label>

                <label>
                  PIN (4–12 ψηφία)
                  <input
                    value={authPin}
                    onChange={(e) => setAuthPin(e.target.value)}
                    placeholder="π.χ. 1234"
                    inputMode="numeric"
                    autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  />
                </label>
              </div>

              {authError ? <div className="notice danger">{authError}</div> : null}
              {cloudBanner ? <div className="notice">{cloudBanner}</div> : null}

              <div className="btnRow">
                <button className="btn primary" onClick={submitAuth} disabled={cloudBusy}>
                  {authMode === "signin" ? "Σύνδεση" : "Δημιουργία"}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setAuthError("");
                    setAuthMode((m) => (m === "signin" ? "signup" : "signin"));
                  }}
                  disabled={cloudBusy}
                >
                  {authMode === "signin" ? "+ Νέος χρήστης" : "Έχω ήδη λογαριασμό"}
                </button>
              </div>

              <div className="sub" style={{ marginTop: 10 }}>
                Μετά τη σύνδεση, μπορείς να κάνεις <b>Import</b> από το παλιό export HTML (programma.html) και μετά
                πατάς <b>Save to Cloud</b>.
              </div>
            </section>
          </div>
        </div>
      );
    }
  }

  /** ===== Screen 1: Sessions setup ===== */
  if (showSlotsSetup) {
    return (
      <div className="page">
        <header className="header">
          <div className="headerRow">
            <h1>Ρύθμιση Sessions (Ωρών)</h1>
            <button className="btn themeBtn" onClick={toggleTheme}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
          <div className="sub">
            Πρόσθεσε/ρύθμισε τις ώρες του πίνακα. Για αλλαγή σειράς: <b>κράτα πατημένο</b> στο ⋮⋮ και <b>σύρε</b>.
          </div>
        </header>

        <div className="layout">
          <section className="panel panelFull">
            <h2>Sessions</h2>

            {slots.length === 0 ? <div className="sub">Δεν υπάρχουν sessions. Πρόσθεσε τουλάχιστον ένα.</div> : null}

            <div className="stack">
              {slots.map((s) => (
                <div
                  key={s.id}
                  className={`li slotRow ${draggingSlotId === s.id ? "dragging" : ""}`}
                  data-slot-row="true"
                  data-id={s.id}
                >
                  <div className="slotRowTop">
                    <div
                      className="dragHandle"
                      title="Σύρε για αλλαγή σειράς"
                      onPointerDown={() => setDraggingSlotId(s.id)}
                    >
                      ⋮⋮
                    </div>
                    <div className="liTitle">Session: {s.label}</div>
                  </div>

                  <div className="formGrid">
                    <label>
                      Έναρξη (HH:MM)
                      <input
                        value={s.start}
                        onChange={(e) => {
                          const v = e.target.value;
                          const nextLabel = isHHMM(v) && isHHMM(s.end) ? recomputeLabel(v, s.end) : s.label;
                          updateSlot(s.id, { start: v, label: nextLabel });
                        }}
                        placeholder="09:00"
                      />
                    </label>

                    <label>
                      Λήξη (HH:MM)
                      <input
                        value={s.end}
                        onChange={(e) => {
                          const v = e.target.value;
                          const nextLabel = isHHMM(s.start) && isHHMM(v) ? recomputeLabel(s.start, v) : s.label;
                          updateSlot(s.id, { end: v, label: nextLabel });
                        }}
                        placeholder="11:00"
                      />
                    </label>
                  </div>

                  <div className="btnRow">
                    <button className="btn danger" onClick={() => deleteSlot(s.id)}>
                      Διαγραφή
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="btnRow">
              <button className="btn primary" onClick={addSlot}>
                + Προσθήκη session
              </button>

              <button
                className="btn"
                onClick={() => {
                  if (slots.length === 0) return alert("Βάλε τουλάχιστον ένα session.");
                  for (const s of slots) {
                    if (!isHHMM(s.start) || !isHHMM(s.end)) return alert("Διόρθωσε ώρες σε μορφή HH:MM (π.χ. 09:00).");
                  }
                  setShowSlotsSetup(false);
                  setShowCoursesSetup(loadCoursesFromStorage().length === 0);
                }}
              >
                Έτοιμο — Πάμε στα μαθήματα
              </button>
            </div>

            <div className="sub">Σημείωση: Τα sessions αποθηκεύονται τοπικά στον browser.</div>
          </section>
        </div>
      </div>
    );
  }

  /** ===== Screen 2: Courses setup ===== */
  if (showCoursesSetup) {
    return (
      <div className="page">
        <header className="header">
          <div className="headerRow">
            <h1>Μαθήματα (Courses)</h1>
            <button className="btn themeBtn" onClick={toggleTheme}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
          <div className="sub">
            Πρόσθεσε τα μαθήματα μία φορά, με <b>default</b> αίθουσα/καθηγητές/σελίδα. Μετά θα τα “βάζεις” στον πίνακα.
          </div>
        </header>

        <div className="layout">
          <section className="panel panelFull">
            <h2>Λίστα μαθημάτων</h2>

            <div className="btnRow">
              <button className="btn primary" onClick={addCourse}>
                + Προσθήκη μαθήματος
              </button>

              <button
                className="btn"
                onClick={() => {
                  if (courses.length === 0) return alert("Πρόσθεσε τουλάχιστον ένα μάθημα.");
                  const hasBad = courses.some((c) => !c.title.trim());
                  if (hasBad) return alert("Κάποιο μάθημα δεν έχει τίτλο. Διόρθωσέ το.");
                  setShowCoursesSetup(false);
                  setForm((p) => ({ ...p, courseId: p.courseId || courses[0].id }));
                }}
              >
                Έτοιμο — Πάμε στο πρόγραμμα
              </button>
            </div>

            {courses.length === 0 ? <div className="sub">Δεν έχεις προσθέσει μαθήματα ακόμα.</div> : null}

            <div className="stack">
              {courses.map((c) => (
                <div key={c.id} className="li">
                  <div className="liTitle">Μάθημα</div>

                  <div className="formGrid">
                    <label className="span2">
                      Τίτλος *
                      <input value={c.title} onChange={(e) => updateCourse(c.id, { title: e.target.value })} />
                    </label>

                    <label>
                      Default αίθουσα
                      <input
                        value={c.defaultRoom}
                        onChange={(e) => updateCourse(c.id, { defaultRoom: e.target.value })}
                        placeholder="π.χ. Αμφ. Α1"
                      />
                    </label>

                    <label>
                      Default καθηγητές
                      <input
                        value={c.defaultProfessors}
                        onChange={(e) => updateCourse(c.id, { defaultProfessors: e.target.value })}
                        placeholder="π.χ. Παπαδόπουλος"
                      />
                    </label>

                    <label className="span2">
                      Σελίδα μαθήματος (URL)
                      <input
                        value={c.courseUrl}
                        onChange={(e) => updateCourse(c.id, { courseUrl: e.target.value })}
                        placeholder="https://..."
                      />
                    </label>
                  </div>

                  <div className="btnRow">
                    <button className="btn danger" onClick={() => deleteCourse(c.id)}>
                      Διαγραφή μαθήματος
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="sub">
              Tip: Αν αλλάξεις defaults εδώ, δεν αλλάζουν αυτόματα τα ήδη καταχωρημένα slots (εκτός αν κάνεις νέα καταχώρηση).
            </div>
          </section>
        </div>
      </div>
    );
  }

  /** ===== Main app ===== */
  return (
    <div className="page">
      <header className="header">
        <div className="headerRow">
          <h1>Εβδομαδιαίο Πρόγραμμα Μαθημάτων</h1>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {cloudEnabled ? (
              <>
                <span className="cloudPill">
                  {profile?.username ? `👤 ${profile.username}` : "👤"}
                  {profile?.is_master ? " (MASTER)" : ""}
                </span>

                <button className="btn" onClick={saveToCloud} disabled={!cloudDirty || cloudBusy} title="Αποθήκευση στη βάση">
                  Save to Cloud
                </button>

                <span className="cloudPill" title="Κατάσταση συγχρονισμού">
                  {cloudBusy ? "Saving…" : cloudDirty ? "Unsaved ●" : "Saved ✅"}
                  {cloudLastSavedAt ? ` • ${new Date(cloudLastSavedAt).toLocaleString("el-GR")}` : ""}
                </span>

                <button className="btn" onClick={signOutCloud} disabled={cloudBusy} title="Αποσύνδεση">
                  Logout
                </button>
              </>
            ) : null}

            <button className="btn themeBtn" onClick={toggleTheme}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </div>
        <div className="sub">Τα export HTML περιέχουν και backup για επαναφορά.</div>
        {cloudEnabled && cloudBanner ? <div className="notice">{cloudBanner}</div> : null}
      </header>

      <div className="layout">
        <section className="panel">
          <h2>Καταχώρηση σε slot</h2>

          <div className="btnRow">
            <button className="btn" onClick={() => setShowSlotsSetup(true)}>
              Ρύθμιση sessions
            </button>
            <button className="btn" onClick={() => setShowCoursesSetup(true)}>
              Διαχείριση μαθημάτων
            </button>
          </div>

          {courses.length === 0 ? (
            <div className="sub">
              Δεν υπάρχουν μαθήματα. Πάτα <b>Διαχείριση μαθημάτων</b> για να προσθέσεις.
            </div>
          ) : (
            <>
              <div className="formGrid">
                <label className="span2">
                  Μάθημα *
                  <select value={form.courseId} onChange={(e) => setForm((p) => ({ ...p, courseId: e.target.value }))}>
                    {courses
                      .slice()
                      .sort((a, b) => a.title.localeCompare(b.title, "el"))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                  </select>
                </label>

                <label>
                  Τύπος (Θ/Ε) *
                  <select
                    value={form.classType}
                    onChange={(e) => setForm((p) => ({ ...p, classType: e.target.value as ClassType }))}
                  >
                    <option value="THEORY">Θεωρία (Θ)</option>
                    <option value="LAB">Εργαστήριο (Ε)</option>
                  </select>
                </label>

                <label>
                  Ημέρα *
                  <select value={form.day} onChange={(e) => setForm((p) => ({ ...p, day: e.target.value as Day }))}>
                    {DAYS.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Session *
                  <select value={form.slotId} onChange={(e) => setForm((p) => ({ ...p, slotId: e.target.value }))}>
                    {slots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Αίθουσα (override)
                  <input
                    value={form.room}
                    onChange={(e) => setForm((p) => ({ ...p, room: e.target.value }))}
                    placeholder="(default από το μάθημα)"
                  />
                </label>

                <label>
                  Καθηγητές (override)
                  <input
                    value={form.professors}
                    onChange={(e) => setForm((p) => ({ ...p, professors: e.target.value }))}
                    placeholder="(default από το μάθημα)"
                  />
                </label>

                <label className="span2">
                  Σελίδα μαθήματος (override URL)
                  <input
                    value={form.courseUrl}
                    onChange={(e) => setForm((p) => ({ ...p, courseUrl: e.target.value }))}
                    placeholder="(default από το μάθημα)"
                  />
                </label>
              </div>

              <div className="btnRow">
                <button className="btn primary" onClick={upsertEntry}>
                  Αποθήκευση στο slot
                </button>

                <button
                  className="btn"
                  onClick={() => {
                    const c = courseMap.get(form.courseId);
                    setForm((p) => ({
                      ...p,
                      classType: "THEORY",
                      room: c?.defaultRoom || "",
                      professors: c?.defaultProfessors || "",
                      courseUrl: c?.courseUrl || "",
                    }));
                  }}
                >
                  Καθαρισμός overrides
                </button>

                <button className="btn danger" onClick={clearAll}>
                  Διαγραφή όλων
                </button>
              </div>
            </>
          )}

          <div className="exportRow">
            <label style={{ minWidth: 220 }}>
              Στυλ Export
              <select value={exportSkin} onChange={(e) => setExportSkin(e.target.value as ExportSkin)}>
                <option value="default">Κανονικό</option>
                <option value="lotr">Lord of the Rings</option>
              </select>
            </label>

            <button className="btn" onClick={openExportPreview}>
              Προεπισκόπηση Export HTML
            </button>
            <button className="btn" onClick={downloadExportHtml}>
              Λήψη HTML αρχείου
            </button>
          </div>

          <div className="backupBox">
            <div className="backupTitle">Backup / Επαναφορά</div>
            <div className="sub">
              Αν χαθούν τα δεδομένα της master συσκευής: κάνεις <b>Επαναφορά</b> από το HTML που είχες κατεβάσει.
            </div>
            <div className="btnRow">
              <button className="btn" onClick={() => restoreInputRef.current?.click()}>
                Επαναφορά από HTML backup
              </button>
            </div>
            <input
              ref={restoreInputRef}
              type="file"
              accept=".html,text/html"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                await restoreFromHtmlFile(f);
              }}
            />
          </div>

          {cloudEnabled ? (
            <div className="backupBox">
              <div className="backupTitle">Cloud Sync</div>
              <div className="sub">
                Import από παλιά έκδοση (programma.html) και μετά <b>Save to Cloud</b> για να συγχρονιστεί σε όλες τις
                συσκευές.
              </div>
              <div className="btnRow">
                <button className="btn" onClick={() => restoreInputRef.current?.click()} disabled={cloudBusy}>
                  Import από HTML
                </button>
                <button className="btn primary" onClick={saveToCloud} disabled={!cloudDirty || cloudBusy}>
                  Save to Cloud
                </button>
                {profile?.is_master ? (
                  <button className="btn" onClick={openMaster} disabled={cloudBusy}>
                    Master panel
                  </button>
                ) : null}
              </div>

              <div className="sub" style={{ marginTop: 10 }}>
                Κατάσταση: {cloudBusy ? "Saving/Loading…" : cloudDirty ? "Unsaved αλλαγές" : "Saved"}
                {cloudLastSavedAt ? ` • Τελευταίο save: ${new Date(cloudLastSavedAt).toLocaleString("el-GR")}` : ""}
              </div>
            </div>
          ) : null}

          {showMasterPanel && profile?.is_master ? (
            <div className="backupBox">
              <div className="backupTitle">MASTER — Χρήστες</div>
              <div className="sub">
                Για ασφάλεια, τα PIN <b>δεν εμφανίζονται</b> (είναι hashed). Μπορείς όμως να κάνεις <b>Reset PIN</b> και
                να ορίσεις προσωρινό PIN.
              </div>

              <div className="btnRow">
                <button
                  className="btn"
                  onClick={async () => {
                    await openMaster();
                  }}
                  disabled={cloudBusy}
                >
                  Refresh
                </button>
                <button className="btn" onClick={() => setShowMasterPanel(false)} disabled={cloudBusy}>
                  Κλείσιμο
                </button>
              </div>

              {!masterRows ? (
                <div className="sub">Φόρτωση…</div>
              ) : (
                <div className="stack" style={{ marginTop: 10 }}>
                  {masterRows.map((r) => (
                    <div key={r.user_id} className="li">
                      <div className="liTitle">{r.username}</div>
                      <div className="liMeta">
                        {r.is_master ? "MASTER" : "user"}
                        {r.created_at ? ` • created: ${new Date(r.created_at).toLocaleString("el-GR")}` : ""}
                      </div>
                      {!r.is_master ? (
                        <div className="btnRow">
                          <button className="btn" onClick={() => doMasterResetPin(r.username)} disabled={cloudBusy}>
                            Reset PIN
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <h2>Πρόγραμμα</h2>

          <div className="tableWrap">
            <table className="timetable">
              <thead>
                <tr>
                  <th className="corner"></th>
                  {DAYS.map((d) => (
                    <th key={d.key} className="colHead">
                      {d.label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {slots.map((s) => (
                  <tr key={s.id}>
                    <th className="rowHead">{s.label}</th>

                    {DAYS.map((d) => {
                      const e = slotMap.get(`${d.key}__${s.id}`);
                      const selected = form.day === d.key && form.slotId === s.id;

                      if (!e) {
                        return (
                          <td
                            key={`${d.key}-${s.id}`}
                            className={`cell empty ${selected ? "selected" : ""}`}
                            onClick={() => setDaySlot(d.key, s.id)}
                            title="Κλικ/Ταπ για επιλογή slot"
                          >
                            <div className="hint">Κλικ για επιλογή slot</div>
                          </td>
                        );
                      }

                      const c = courseMap.get(e.courseId);
                      const title = c?.title ?? "—";
                      const room = effectiveRoom(e, c);

                      return (
                        <td
                          key={`${d.key}-${s.id}`}
                          className={`cell filled ${selected ? "selected" : ""}`}
                          onClick={() => setDaySlot(d.key, s.id)}
                          title="Κλικ/Ταπ για επεξεργασία του slot"
                        >
                          <div className="cellTitle">{title}</div>
                          <div className="cellMeta">
                            <span className="badge">{typeShort(e.classType)}</span>
                            <span className="room">{room}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt">Λίστα μαθημάτων</h2>

          {groups.length === 0 ? (
            <div className="muted">Δεν υπάρχουν καταχωρήσεις ακόμα.</div>
          ) : (
            <ul className="list">
              {groups.map(({ course, sessions }) => (
                <li key={course.id} className="li">
                  <div className="liTitle">{course.title}</div>

                  <div className="liMeta">
                    <b>Καθηγητές:</b> {course.defaultProfessors?.trim() ? course.defaultProfessors : "—"}
                  </div>

                  <div className="liMeta">
                    <b>Σελίδα:</b>{" "}
                    {course.courseUrl?.trim() ? (
                      <a href={course.courseUrl} target="_blank" rel="noreferrer">
                        {course.courseUrl}
                      </a>
                    ) : (
                      "—"
                    )}
                  </div>

                  <div className="liMeta">
                    <b>Ώρες/slots:</b>
                  </div>

                  {sessions.map((s) => (
                    <div key={s.id} className="sessionRow">
                      <span>
                        {dayLabel(s.day)} — {slotLabel(s.slotId, slots)}
                      </span>
                      <span className="badge">{typeShort(s.classType)}</span>
                      <span className="room">{effectiveRoom(s, courseMap.get(s.courseId))}</span>

                      <button className="mini danger" onClick={() => removeEntry(s.id)}>
                        Διαγραφή
                      </button>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
