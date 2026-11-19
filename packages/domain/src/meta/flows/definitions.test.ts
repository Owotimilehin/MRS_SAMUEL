import { describe, it, expect } from "vitest";
import { WA_FLOWS, flowDef } from "@ms/shared";
import { flowJson, flowJsonHash, flowJsonText, flowJsonVersion, flowKeysWithJson } from "./definitions.js";

type Obj = Record<string, unknown>;
const screensOf = (key: string): Obj[] => (flowJson(key)!.screens as Obj[]) ?? [];
const childrenOf = (screen: Obj): Obj[] => ((screen.layout as Obj).children as Obj[]) ?? [];
const footerOf = (screen: Obj): Obj | undefined => childrenOf(screen).find((c) => c.type === "Footer");
const actionOf = (screen: Obj): Obj => (footerOf(screen)!["on-click-action"] as Obj) ?? {};

/** Limits from spec 07 section 3.3. */
const LABEL_LIMIT: Record<string, number> = { TextInput: 20, TextArea: 20, RadioButtonsGroup: 30, CheckboxGroup: 30, Dropdown: 20, DatePicker: 40, OptIn: 120, Footer: 35 };
const TEXT_LIMIT: Record<string, number> = { TextHeading: 80, TextSubheading: 80, TextBody: 4096, TextCaption: 400 };
const KNOWN = new Set([...Object.keys(LABEL_LIMIT), ...Object.keys(TEXT_LIMIT)]);

const keys = flowKeysWithJson();
const staticKeys = keys.filter((k) => !flowDef(k)!.usesEndpoint);

describe("Flow JSON definitions (suite spec 07, section 7.1)", () => {
  it("every registry form of this build has a file", () => {
    for (const key of ["delivery_address", "bulk_order", "complaint", "pickup_request", "delivery_slot"]) expect(keys).toContain(key);
    expect(staticKeys).toEqual(["delivery_address", "bulk_order", "complaint", "pickup_request"]);
    for (const key of keys) expect(flowDef(key)).not.toBeNull();
    expect(flowJson("nope")).toBeNull();
    expect(() => flowJsonText("nope")).toThrow();
  });

  it("every definition parses, has version 7.3 and a terminal screen with a Footer", () => {
    for (const key of keys) {
      expect(JSON.parse(flowJsonText(key))).toEqual(flowJson(key));
      expect(flowJsonVersion(key)).toBe("7.3");
      const terminal = screensOf(key).filter((s) => s.terminal === true);
      expect(terminal.length).toBeGreaterThan(0);
      for (const s of terminal) expect(footerOf(s)).toBeDefined();
      // Every screen has exactly one Footer and a title.
      for (const s of screensOf(key)) {
        expect(childrenOf(s).filter((c) => c.type === "Footer")).toHaveLength(1);
        expect(typeof s.title).toBe("string");
        expect((s.layout as Obj).type).toBe("SingleColumnLayout");
      }
    }
  });

  it("every screen id is upper-case letters and underscores and is not SUCCESS", () => {
    for (const key of keys) {
      const ids = screensOf(key).map((s) => String(s.id));
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[A-Z_]+$/);
        expect(id).not.toBe("SUCCESS");
      }
    }
  });

  it("labels and helper texts are within the limits in section 3.3", () => {
    for (const key of keys) {
      for (const s of screensOf(key)) {
        for (const c of childrenOf(s)) {
          const type = String(c.type);
          expect(KNOWN.has(type), `${key}: unexpected component ${type}`).toBe(true);
          if (LABEL_LIMIT[type] !== undefined) {
            const label = String(c.label ?? "");
            expect(label.trim().length, `${key} ${type} label`).toBeGreaterThan(0);
            expect(label.length, `${key} "${label}"`).toBeLessThanOrEqual(LABEL_LIMIT[type]!);
          }
          if (TEXT_LIMIT[type] !== undefined) {
            const text = String(c.text ?? "");
            expect(text.trim().length).toBeGreaterThan(0);
            expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT[type]!);
          }
          if (c["helper-text"] !== undefined) expect(String(c["helper-text"]).length).toBeLessThanOrEqual(80);
          if (type !== "Footer" && LABEL_LIMIT[type] !== undefined) expect(String(c.name ?? "")).toMatch(/^[a-z_]+$/);
          if (type === "TextInput") expect(["text", "number", "email", "password", "passcode", "phone"]).toContain(c["input-type"]);
          // The types of these are unverified at Meta, so the forms do not set them.
          for (const unset of ["min-chars", "max-chars", "max-length"]) expect(c[unset]).toBeUndefined();
          const source = c["data-source"];
          if (Array.isArray(source)) {
            expect(source.length).toBeGreaterThanOrEqual(1);
            expect(source.length).toBeLessThanOrEqual(type === "Dropdown" ? 200 : 20);
            // Meta's guidance: a dropdown for 8 or more options, radio buttons for fewer.
            if (type === "Dropdown") expect(source.length).toBeGreaterThanOrEqual(8);
            if (type === "RadioButtonsGroup") expect(source.length).toBeLessThan(8);
            const ids = (source as Obj[]).map((o) => String(o.id));
            expect(new Set(ids).size).toBe(ids.length);
            for (const o of source as Obj[]) {
              expect(String(o.title).length).toBeLessThanOrEqual(30);
              expect(String(o.title).trim().length).toBeGreaterThan(0);
            }
          }
        }
      }
      // null is not supported anywhere in Flow JSON payloads.
      expect(flowJsonText(key)).not.toMatch(/:\s*null/);
    }
  });

  it("every registry field is in the complete payload, and the payload carries flow_key", () => {
    for (const key of staticKeys) {
      const def = flowDef(key)!;
      const completes = screensOf(key)
        .map(actionOf)
        .filter((a) => a.name === "complete");
      expect(completes).toHaveLength(1);
      const payload = completes[0]!.payload as Obj;
      expect(payload.flow_key).toBe(key);
      for (const f of def.fields) expect(Object.keys(payload), `${key}.${f.name}`).toContain(f.name);
      // Nothing is sent back that the registry does not know.
      expect(Object.keys(payload).filter((k) => k !== "flow_key").sort()).toEqual(def.fields.map((f) => f.name).sort());
      // Every answer in the payload points at an input that exists, on the screen it names.
      for (const [name, ref] of Object.entries(payload)) {
        if (name === "flow_key") continue;
        const m = /^\$\{(?:screen\.([A-Z_]+)\.)?form\.([a-z_]+)\}$/.exec(String(ref));
        expect(m, `${key}.${name} = ${String(ref)}`).not.toBeNull();
        const terminal = screensOf(key).find((s) => actionOf(s).name === "complete")!;
        const screen = m![1] ? screensOf(key).find((s) => s.id === m![1]) : terminal;
        expect(screen, `${key}: screen ${m![1]}`).toBeDefined();
        expect(childrenOf(screen!).some((c) => c.name === m![2])).toBe(true);
        expect(m![2]).toBe(name);
      }
      // The registry's choices are the form's choices.
      for (const f of def.fields.filter((x) => x.kind === "choice")) {
        const comp = screensOf(key).flatMap(childrenOf).find((c) => c.name === f.name)!;
        const fromJson = Object.fromEntries((comp["data-source"] as Obj[]).map((o) => [String(o.id), String(o.title)]));
        expect(f.options).toEqual(fromJson);
      }
    }
  });

  it("no screen has more than 50 components; the entry screen exists", () => {
    for (const key of keys) {
      for (const s of screensOf(key)) expect(childrenOf(s).length).toBeLessThanOrEqual(50);
      const ids = screensOf(key).map((s) => s.id);
      expect(ids).toContain(flowDef(key)!.entryScreen);
      // The entry screen is the first one, and every navigate lands on a screen that exists.
      expect(ids[0]).toBe(flowDef(key)!.entryScreen);
      for (const s of screensOf(key)) {
        const a = actionOf(s);
        if (a.name === "navigate") expect(ids).toContain((a.next as Obj).name);
      }
    }
  });

  it("only delivery_slot has data_api_version and routing_model", () => {
    for (const key of keys) {
      const j = flowJson(key)!;
      const dynamic = key === "delivery_slot";
      expect(j.data_api_version !== undefined).toBe(dynamic);
      expect(j.routing_model !== undefined).toBe(dynamic);
      expect(flowDef(key)!.usesEndpoint).toBe(dynamic);
      if (!dynamic) expect(flowJsonText(key)).not.toContain("data_exchange");
    }
  });

  it("the delivery-slot form routes PICK_DAY to PICK_TIME, declares its data with examples and ends with data_exchange", () => {
    const j = flowJson("delivery_slot")!;
    expect(j.data_api_version).toBe("3.0");
    expect(j.routing_model).toEqual({ PICK_DAY: ["PICK_TIME"], PICK_TIME: [] });
    const [day, time] = screensOf("delivery_slot") as [Obj, Obj];
    expect([day.id, time.id]).toEqual(["PICK_DAY", "PICK_TIME"]);
    expect(day.terminal).toBeUndefined();
    expect(time.terminal).toBe(true);
    for (const s of [day, time]) {
      for (const decl of Object.values(s.data as Record<string, Obj>)) expect(decl.__example__).toBeDefined();
    }
    expect(Object.keys(day.data as Obj)).toEqual(["days"]);
    expect(Object.keys(time.data as Obj).sort()).toEqual(["day", "day_label", "slots"]);
    expect(actionOf(day)).toEqual({ name: "data_exchange", payload: { day: "${form.day}" } });
    expect(actionOf(time)).toEqual({ name: "data_exchange", payload: { day: "${data.day}", slot: "${form.slot}" } });
    const radio = (s: Obj): Obj => childrenOf(s).find((c) => c.type === "RadioButtonsGroup")!;
    expect(radio(day)).toMatchObject({ name: "day", label: "Delivery day", required: true, "data-source": "${data.days}" });
    expect(radio(time)).toMatchObject({ name: "slot", label: "Delivery time", required: true, "data-source": "${data.slots}" });
    // No `complete` action: the endpoint's final answer ends the form.
    expect(flowJsonText("delivery_slot")).not.toContain('"complete"');
    expect(flowDef("delivery_slot")!.fields.map((f) => f.name)).toEqual(["slot_label"]);
  });

  it("flowJsonHash is stable for the same file", () => {
    for (const key of keys) {
      expect(flowJsonHash(key)).toMatch(/^[0-9a-f]{64}$/);
      expect(flowJsonHash(key)).toBe(flowJsonHash(key));
    }
    expect(new Set(keys.map(flowJsonHash)).size).toBe(keys.length);
    expect(WA_FLOWS.length).toBeGreaterThanOrEqual(keys.length);
  });
});
