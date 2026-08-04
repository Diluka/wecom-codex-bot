import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildOwnerDeveloperInstructions,
  buildTurnAuthorityContext,
  classifyRequestAuthority,
  normalizeOwnerUserId,
  RESTRICTED_TURN_POLICY,
} from "./owner-policy.ts";

describe("normalizeOwnerUserId", () => {
  it("returns undefined for a missing owner user ID", () => {
    assertEquals(normalizeOwnerUserId(undefined), undefined);
  });

  it("returns undefined for a blank owner user ID", () => {
    assertEquals(normalizeOwnerUserId("   "), undefined);
  });

  it("returns undefined for Unicode controls and separators within an ID", () => {
    for (
      const value of [
        "owner\u0000id",
        "owner\tid",
        "owner\u0085id",
        "owner\u2028id",
        "owner\u2029id",
      ]
    ) {
      assertEquals(normalizeOwnerUserId(value), undefined);
    }
  });

  it("rejects trimmable Unicode controls and separators at either edge", () => {
    for (
      const value of [
        "\towner",
        "owner\t",
        "\rowner",
        "owner\r",
        "\nowner",
        "owner\n",
        "\u2028owner",
        "owner\u2028",
        "\u2029owner",
        "owner\u2029",
      ]
    ) {
      assertEquals(normalizeOwnerUserId(value), undefined);
    }
  });

  it("trims the owner user ID", () => {
    assertEquals(normalizeOwnerUserId("  owner.team  "), "owner.team");
  });

  it("preserves case and otherwise-valid characters", () => {
    assertEquals(
      normalizeOwnerUserId("OwNeR/@example:团队"),
      "OwNeR/@example:团队",
    );
  });
});

describe("classifyRequestAuthority", () => {
  it("restricts a batch when no owner is configured", () => {
    assertEquals(
      classifyRequestAuthority(undefined, ["alice"]),
      "restricted",
    );
  });

  it("restricts an empty batch", () => {
    assertEquals(classifyRequestAuthority("alice", []), "restricted");
  });

  it("restricts a batch when any sender differs from the owner", () => {
    assertEquals(
      classifyRequestAuthority("alice", ["alice", "bob", "alice"]),
      "restricted",
    );
  });

  it("compares every sender with the owner case-sensitively", () => {
    assertEquals(
      classifyRequestAuthority("Alice", ["Alice", "alice"]),
      "restricted",
    );
  });

  it("grants owner authority only when every sender exactly matches", () => {
    assertEquals(
      classifyRequestAuthority("Alice", ["Alice", "Alice"]),
      "owner",
    );
  });
});

describe("buildOwnerDeveloperInstructions", () => {
  it("normalizes and safely delimits the configured owner user ID", () => {
    const ownerUserId = 'Owner "A" \\ root';
    const instructions = buildOwnerDeveloperInstructions(
      `  ${ownerUserId}  `,
    );

    assertStringIncludes(
      instructions,
      `Configured owner user ID: ${JSON.stringify(ownerUserId)}.`,
    );
  });

  it("treats a missing, blank, or invalid owner user ID as unconfigured", () => {
    const expected = buildOwnerDeveloperInstructions();

    assertEquals(buildOwnerDeveloperInstructions("   "), expected);
    assertEquals(buildOwnerDeveloperInstructions("owner\u0000id"), expected);
    assertStringIncludes(
      expected,
      "No owner user ID is configured; every turn is restricted.",
    );
  });

  it("renders the restricted-turn policy into developer instructions", () => {
    const instructions = buildOwnerDeveloperInstructions("Alice");

    assertEquals(
      instructions,
      [
        "Owner-authority and restricted-turn isolation policy:",
        'Configured owner user ID: "Alice".',
        RESTRICTED_TURN_POLICY,
      ].join("\n"),
    );
  });
});

describe("buildTurnAuthorityContext", () => {
  it("builds the exact owner context value", () => {
    assertEquals(
      buildTurnAuthorityContext("owner"),
      "Bot verified authority for the current turn: owner",
    );
  });

  it("builds the exact restricted context value", () => {
    assertEquals(
      buildTurnAuthorityContext("restricted"),
      "Bot verified authority for the current turn: restricted",
    );
  });
});
