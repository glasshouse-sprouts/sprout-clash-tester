// @vitest-environment jsdom
//
// Payload tests: drive the real desktop controls and assert what reaches
// the main process. The renderer's forms only edit renderer state; the
// project crosses to main through `window.api.runDetection` (Run) and
// `window.api.saveProject` (Save), so that is what these tests check.
// `window.api` is a fake that records every call — no Electron needed.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ProjectRuleCustom } from "@clash-tester/core/types";
import { SELF_CHECK_DEFAULT_EXCLUDE } from "@clash-tester/core/types";
import type { RunDetectionArgs } from "../../shared/api";
import App from "./App";

interface Call {
  name: string;
  args: unknown[];
}

const PROJECT_PATH = "/projects/test.clashproj";

function baseProject(rules: Project["rules"] = []): Project {
  return {
    version: 1,
    name: "Payload test",
    createdAt: "2026-01-01T00:00:00Z",
    files: [
      { id: "ark", path: "/models/ARK.ifc", discipline: "ARCH" },
      { id: "kon", path: "/models/KON.ifc", discipline: "STR" },
    ],
    rules,
    settings: {},
  };
}

/** Install a fake `window.api` / `window.events`; returns the call log. */
function installFakeApi(project: Project | null): Call[] {
  const calls: Call[] = [];
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    openProjectDialog: () => ({
      ok: true,
      value: project ? { path: PROJECT_PATH, project } : null,
    }),
    runDetection: () => ({ ok: false, error: "fake engine" }),
    checkAlignment: () => ({ ok: false, error: "not in this test" }),
    pingPaths: (paths) => ({
      ok: true,
      value: (paths as string[]).map((p) => ({ path: p, isFile: true, isIfc: p.endsWith(".ifc") })),
    }),
  };
  const api = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        (...args: unknown[]) => {
          calls.push({ name, args });
          // Synchronous in the real preload too.
          if (name === "getPathForFile") return `/models/${(args[0] as File).name}`;
          const answer = answers[name];
          return Promise.resolve(answer ? answer(...args) : { ok: true, value: true });
        },
    },
  );
  const events = new Proxy({}, { get: () => () => {} });
  Object.assign(window, { api, events });
  return calls;
}

/** Open the fake project through the real Open button. */
async function openProject(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByText("/models/ARK.ifc");
}

/** Press Run and return the project that was sent to main. */
async function runPayload(
  user: ReturnType<typeof userEvent.setup>,
  calls: Call[],
): Promise<Project> {
  await user.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(calls.some((c) => c.name === "runDetection")).toBe(true));
  const call = calls.filter((c) => c.name === "runDetection").at(-1)!;
  return (call.args[0] as RunDetectionArgs).project;
}

function customRule(project: Project, name: string): ProjectRuleCustom {
  const rule = project.rules.find((r) => r.name === name);
  if (!rule || !("a" in rule)) throw new Error(`no custom rule ${name}`);
  return rule;
}

afterEach(() => cleanup());

describe("desktop payloads — what reaches the main process", () => {
  it("Files: dropped IFCs and a changed discipline are sent with Run", async () => {
    const calls = installFakeApi(null);
    const user = userEvent.setup();
    render(<App />);
    const drop = (names: string[]) =>
      fireEvent.drop(window, {
        dataTransfer: { files: names.map((n) => new File([""], n)) },
      });
    drop(["ARK_house.ifc", "notes.txt", "Building-Structural.ifc"]);
    const row = (await screen.findByText("/models/Building-Structural.ifc")).closest("tr")!;
    await user.selectOptions(within(row).getByRole("combobox"), "STR");
    expect(calls.find((c) => c.name === "pingPaths")?.args[0]).toEqual([
      "/models/ARK_house.ifc",
      "/models/notes.txt",
      "/models/Building-Structural.ifc",
    ]);

    // A rule is needed before Run is allowed: add a self check.
    await user.click(screen.getByRole("button", { name: "Rules" }));
    await user.click(screen.getByRole("button", { name: "Add self check" }));
    const sent = await runPayload(user, calls);
    expect(sent.files.map((f) => [f.path, f.discipline])).toEqual([
      ["/models/ARK_house.ifc", "ARCH"],
      ["/models/Building-Structural.ifc", "STR"],
    ]);
  });

  it("Rules: a custom rule from the form, excludes included", async () => {
    const calls = installFakeApi(baseProject());
    const user = userEvent.setup();
    render(<App />);
    await openProject(user);
    await user.click(screen.getByRole("button", { name: "Rules" }));

    await user.type(screen.getByLabelText("Name"), "Ducts vs beams");
    await user.selectOptions(screen.getByLabelText("Side A — file"), "ark");
    await user.clear(screen.getByLabelText("Side A — selector"));
    await user.type(screen.getByLabelText("Side A — selector"), "IfcDuct*");
    await user.type(screen.getByLabelText("Side A — exclude (optional)"), "IfcSpace");
    await user.selectOptions(screen.getByLabelText("Side B — file"), "kon");
    await user.clear(screen.getByLabelText("Side B — selector"));
    await user.type(screen.getByLabelText("Side B — selector"), "IfcBeam|IfcColumn");
    await user.click(screen.getByRole("button", { name: "Add custom rule" }));

    const sent = await runPayload(user, calls);
    expect(customRule(sent, "Ducts vs beams")).toEqual({
      name: "Ducts vs beams",
      preset: null,
      enabled: true,
      a: { fileId: "ark", selector: "IfcDuct*", mode: "i", exclude: "IfcSpace" },
      b: { fileId: "kon", selector: "IfcBeam|IfcColumn", mode: "i" },
    });
  });

  it("Rules: editing a custom rule inline changes what is sent", async () => {
    const rule: ProjectRuleCustom = {
      name: "R1",
      preset: null,
      enabled: true,
      a: { fileId: "ark", selector: "IfcWall", mode: "i" },
      b: { fileId: "kon", selector: "IfcBeam", mode: "i", exclude: "IfcPlate" },
    };
    const calls = installFakeApi(baseProject([rule]));
    const user = userEvent.setup();
    render(<App />);
    await openProject(user);
    await user.click(screen.getByRole("button", { name: "Rules" }));
    await user.click(screen.getByTitle("Edit rule"));

    // The inline form sits in the rules table (the add form is below it).
    const editForm = within(screen.getByRole("table"));
    const bSelector = editForm.getByLabelText("Side B — selector");
    await user.clear(bSelector);
    await user.type(bSelector, "IfcColumn");
    await user.clear(editForm.getByLabelText("Side B — exclude (optional)"));
    await user.click(editForm.getByRole("button", { name: "Save changes" }));

    const sent = await runPayload(user, calls);
    expect(customRule(sent, "R1").a).toEqual(rule.a);
    expect(customRule(sent, "R1").b).toEqual({ fileId: "kon", selector: "IfcColumn", mode: "i" });
  });

  it("Rules: self check with and without the default exclude", async () => {
    const calls = installFakeApi(baseProject());
    const user = userEvent.setup();
    render(<App />);
    await openProject(user);
    await user.click(screen.getByRole("button", { name: "Rules" }));

    const section = screen.getByRole("heading", { name: "Self check" }).closest("section")!;
    // First file (ark), checkbox on by default.
    await user.click(within(section).getByRole("button", { name: "Add self check" }));
    // Second file (kon), checkbox off.
    await user.selectOptions(within(section).getByRole("combobox"), "kon");
    await user.click(within(section).getByLabelText(/Ignore spaces, zones and openings/));
    await user.click(within(section).getByRole("button", { name: "Add self check" }));

    const sent = await runPayload(user, calls);
    const ark = customRule(sent, "SELF-ark");
    expect(ark.a).toEqual({ fileId: "ark", selector: "*", mode: "i", exclude: SELF_CHECK_DEFAULT_EXCLUDE });
    expect(ark.b).toEqual(ark.a);
    const kon = customRule(sent, "SELF-kon");
    expect(kon.a).toEqual({ fileId: "kon", selector: "*", mode: "i" });
    expect(kon.b).toEqual(kon.a);
  });

  it("Rules: a preset rule from the preset picker", async () => {
    const calls = installFakeApi(baseProject());
    const user = userEvent.setup();
    render(<App />);
    await openProject(user);
    await user.click(screen.getByRole("button", { name: "Rules" }));

    const section = screen.getByRole("heading", { name: "Add a preset rule" }).closest("section")!;
    await user.selectOptions(within(section).getByRole("combobox"), "STRxARCH");
    await user.click(within(section).getByRole("button", { name: "Add" }));

    const sent = await runPayload(user, calls);
    expect(sent.rules).toEqual([{ name: "STRxARCH", preset: "STRxARCH", enabled: true }]);
  });

  it("Settings: relation skip, narrow phase and touch reporting, on Run and on Save", async () => {
    const rule = { name: "STRxARCH", preset: "STRxARCH", enabled: true };
    const calls = installFakeApi(baseProject([rule]));
    const user = userEvent.setup();
    render(<App />);
    await openProject(user);
    await user.click(screen.getByRole("button", { name: "Rules" }));

    await user.click(screen.getByLabelText(/Skip elements that belong together/));
    await user.click(screen.getByLabelText(/Use the ifc-lite narrow phase/));
    await user.click(await screen.findByLabelText(/List touching and unconfirmed pairs/));

    const expected = { skipRelatedElements: false, narrowPhase: "ifclite", reportTouch: true };
    const sent = await runPayload(user, calls);
    expect(sent.settings).toEqual(expected);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.name === "saveProject")).toBe(true));
    const save = calls.find((c) => c.name === "saveProject")!;
    expect(save.args[0]).toBe(PROJECT_PATH);
    expect((save.args[1] as Project).settings).toEqual(expected);
  });

  it("Settings: BCF topics per group from the top bar", async () => {
    const rule = { name: "STRxARCH", preset: "STRxARCH", enabled: true };
    const calls = installFakeApi(baseProject([rule]));
    const user = userEvent.setup();
    render(<App />);
    await openProject(user);

    await user.selectOptions(screen.getByLabelText("BCF topics"), "group");
    const sent = await runPayload(user, calls);
    expect(sent.settings.bcfTopics).toBe("group");
  });
});
