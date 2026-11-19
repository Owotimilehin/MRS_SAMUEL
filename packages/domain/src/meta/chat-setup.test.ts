import { describe, it, expect } from "vitest";
import type { ChatSetupConfig } from "@ms/shared";
import { configToProfile, liveMatches, planPublish, profileToConfig, type LiveProfile } from "./chat-setup.js";

const full: ChatSetupConfig = {
  greeting: "Hello {{user_first_name}}",
  getStarted: true,
  iceBreakers: ["What juices do you have today?", "Do you deliver to my area?"],
  menu: [
    { type: "postback", title: "Talk to us" },
    { type: "web_url", title: "Our shop", url: "https://www.mrssamuel.com" },
  ],
};
const empty: ChatSetupConfig = { greeting: null, getStarted: false, iceBreakers: [], menu: [] };

describe("configToProfile", () => {
  it("configToProfile: messenger full set-up produces the four properties with ms:v1 payloads", () => {
    expect(configToProfile(full, "messenger")).toEqual({
      greeting: [{ locale: "default", text: "Hello {{user_first_name}}" }],
      get_started: { payload: "ms:v1:start" },
      ice_breakers: [
        {
          locale: "default",
          call_to_actions: [
            { question: "What juices do you have today?", payload: "ms:v1:ice:1" },
            { question: "Do you deliver to my area?", payload: "ms:v1:ice:2" },
          ],
        },
      ],
      persistent_menu: [
        {
          locale: "default",
          composer_input_disabled: false,
          call_to_actions: [
            { type: "postback", title: "Talk to us", payload: "ms:v1:menu:1" },
            { type: "web_url", title: "Our shop", url: "https://www.mrssamuel.com", webview_height_ratio: "full" },
          ],
        },
      ],
    });
  });

  it("configToProfile: a menu forces get_started even when the switch is off", () => {
    const p = configToProfile({ ...full, getStarted: false, greeting: null }, "messenger");
    expect(p.get_started).toEqual({ payload: "ms:v1:start" });
    expect(p.greeting).toBeUndefined();
  });

  it("configToProfile: instagram omits greeting, get_started, composer_input_disabled and webview_height_ratio", () => {
    const p = configToProfile(full, "instagram");
    expect(p.greeting).toBeUndefined();
    expect(p.get_started).toBeUndefined();
    expect(p.ice_breakers).toHaveLength(1);
    expect(p.persistent_menu).toEqual([
      {
        locale: "default",
        call_to_actions: [
          { type: "postback", title: "Talk to us", payload: "ms:v1:menu:1" },
          { type: "web_url", title: "Our shop", url: "https://www.mrssamuel.com" },
        ],
      },
    ]);
    expect(JSON.stringify(p)).not.toContain("composer_input_disabled");
    expect(JSON.stringify(p)).not.toContain("webview_height_ratio");
  });
});

describe("profileToConfig", () => {
  it("profileToConfig: reads the default locale, lists other locales, flags foreign payloads and a disabled composer", () => {
    const live: LiveProfile = {
      get_started: { payload: "GET_STARTED" },
      greeting: [
        { locale: "default", text: "Hi" },
        { locale: "fr_FR", text: "Salut" },
      ],
      ice_breakers: [{ locale: "default", call_to_actions: [{ question: "Q1", payload: "ms:v1:ice:1" }] }],
      persistent_menu: [
        {
          locale: "default",
          composer_input_disabled: true,
          call_to_actions: [
            { type: "postback", title: "A", payload: "ms:v1:menu:1" },
            { type: "web_url", title: "B", url: "https://x.example" },
            { type: "nested", title: "C" },
          ],
        },
        { locale: "es_ES", composer_input_disabled: false, call_to_actions: [] },
      ],
    };
    const r = profileToConfig(live, "messenger");
    expect(r.config).toEqual({
      greeting: "Hi",
      getStarted: true,
      iceBreakers: ["Q1"],
      menu: [
        { type: "postback", title: "A" },
        { type: "web_url", title: "B", url: "https://x.example" },
      ],
    });
    expect(r.otherLocales.sort()).toEqual(["es_ES", "fr_FR"]);
    expect(r.foreignPayloads).toBe(true);
    expect(r.composerDisabled).toBe(true);
  });

  it("profileToConfig: our own set-up reads back clean; the first entry is used when none is marked default", () => {
    const r = profileToConfig(configToProfile(full, "messenger"), "messenger");
    expect(r).toEqual({ config: full, otherLocales: [], foreignPayloads: false, composerDisabled: false });
    const noDefault = profileToConfig({ greeting: [{ locale: "en_US", text: "Hey" }] }, "messenger");
    expect(noDefault.config.greeting).toBe("Hey");
    expect(noDefault.otherLocales).toEqual([]);
  });

  it("profileToConfig: cuts lists to the suite's limits and ignores greeting and get_started for instagram", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ type: "postback", title: `B${i}`, payload: `ms:v1:menu:${i + 1}` }));
    const r = profileToConfig(
      {
        get_started: { payload: "ms:v1:start" },
        greeting: [{ locale: "default", text: "x" }],
        ice_breakers: [{ call_to_actions: Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, payload: `ms:v1:ice:${(i % 4) + 1}` })) }],
        persistent_menu: [{ locale: "default", call_to_actions: many }],
      },
      "instagram",
    );
    expect(r.config.greeting).toBeNull();
    expect(r.config.getStarted).toBe(false);
    expect(r.config.iceBreakers).toHaveLength(4);
    expect(r.config.menu).toHaveLength(5);
  });
});

describe("planPublish", () => {
  it("planPublish: nothing live → set A without menu, then set B with menu (messenger)", () => {
    const plan = planPublish(full, {}, "messenger");
    expect(plan.map((s) => [s.op, s.fields])).toEqual([
      ["set", ["greeting", "get_started", "ice_breakers"]],
      ["set", ["persistent_menu"]],
    ]);
  });

  it("planPublish: get_started already live → one set call", () => {
    const plan = planPublish(full, { get_started: { payload: "ms:v1:start" } }, "messenger");
    expect(plan).toHaveLength(1);
    expect(plan[0]!.op).toBe("set");
    expect(plan[0]!.fields).toEqual(["greeting", "get_started", "ice_breakers", "persistent_menu"]);
  });

  it("planPublish: instagram → one set call including the menu", () => {
    const plan = planPublish(full, {}, "instagram");
    expect(plan).toHaveLength(1);
    expect(plan[0]!.fields).toEqual(["ice_breakers", "persistent_menu"]);
  });

  it("planPublish: removing everything → one delete with all live fields, no set", () => {
    const live = configToProfile(full, "messenger");
    const plan = planPublish(empty, live, "messenger");
    expect(plan).toEqual([
      { op: "delete", fields: ["get_started", "greeting", "ice_breakers", "persistent_menu"], body: { fields: ["get_started", "greeting", "ice_breakers", "persistent_menu"] } },
    ]);
  });

  it("planPublish: removing only what is live deletes only that", () => {
    const live: LiveProfile = { ice_breakers: configToProfile(full, "messenger").ice_breakers! };
    expect(planPublish(empty, live, "messenger")).toEqual([{ op: "delete", fields: ["ice_breakers"], body: { fields: ["ice_breakers"] } }]);
  });

  it("planPublish: removing get_started always removes persistent_menu in the same delete", () => {
    const live = configToProfile({ ...empty, menu: [{ type: "postback", title: "A" }] }, "messenger");
    const plan = planPublish({ ...empty, iceBreakers: ["Hi?"] }, live, "messenger");
    expect(plan[0]).toMatchObject({ op: "delete", fields: ["get_started", "persistent_menu"] });
    expect(plan[1]).toMatchObject({ op: "set", fields: ["ice_breakers"] });
  });

  it("planPublish: unchanged → empty plan", () => {
    expect(planPublish(full, configToProfile(full, "messenger"), "messenger")).toEqual([]);
    expect(planPublish(full, configToProfile(full, "instagram"), "instagram")).toEqual([]);
    expect(planPublish(empty, {}, "messenger")).toEqual([]);
  });

  it("planPublish: other languages live → a plan even when the default matches (the set replaces all of them)", () => {
    const live = configToProfile(full, "messenger");
    live.greeting = [...live.greeting!, { locale: "fr_FR", text: "Salut" }];
    const plan = planPublish(full, live, "messenger");
    expect(plan.length).toBeGreaterThan(0);
  });
});

describe("liveMatches", () => {
  it("liveMatches: order of questions matters; extra locales do not", () => {
    const live = configToProfile(full, "messenger");
    expect(liveMatches(full, live, "messenger")).toBe(true);
    expect(liveMatches({ ...full, iceBreakers: [...full.iceBreakers].reverse() }, live, "messenger")).toBe(false);
    const withExtra: LiveProfile = {
      ...live,
      greeting: [...live.greeting!, { locale: "fr_FR", text: "Salut" }],
    };
    expect(liveMatches(full, withExtra, "messenger")).toBe(true);
  });

  it("liveMatches: a foreign Get started payload, a disabled message box or a different link do not match", () => {
    const live = configToProfile(full, "messenger");
    expect(liveMatches(full, { ...live, get_started: { payload: "GET_STARTED" } }, "messenger")).toBe(false);
    expect(liveMatches(full, { ...live, persistent_menu: [{ ...live.persistent_menu![0]!, composer_input_disabled: true }] }, "messenger")).toBe(false);
    const other = { ...full, menu: [full.menu[0]!, { type: "web_url" as const, title: "Our shop", url: "https://other.example" }] };
    expect(liveMatches(other, live, "messenger")).toBe(false);
    expect(liveMatches(empty, {}, "messenger")).toBe(true);
  });
});
