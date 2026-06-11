import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("workspace-artifacts", () => {
  it("declares plugin metadata", () => {
    expect(entry.id).toBe("workspace-artifacts");
    expect(entry.name).toBe("Workspace Artifacts");
  });
});
