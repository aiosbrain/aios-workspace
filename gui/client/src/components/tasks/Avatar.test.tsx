import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssigneeAvatar, initialsOf, splitAssignees, toneIndexOf } from "./Avatar";

describe("splitAssignees", () => {
  test("treats every multi-person separator in real tasks files as a split", () => {
    // "John + Chetan" is the actual value in john-workspace's tasks-team.md.
    expect(splitAssignees("John + Chetan")).toEqual(["John", "Chetan"]);
    expect(splitAssignees("John, Chetan")).toEqual(["John", "Chetan"]);
    expect(splitAssignees("John & Chetan")).toEqual(["John", "Chetan"]);
    expect(splitAssignees("John and Chetan")).toEqual(["John", "Chetan"]);
    expect(splitAssignees("John / Chetan")).toEqual(["John", "Chetan"]);
  });

  test("a single assignee stays one person, and blanks never become ghost people", () => {
    expect(splitAssignees("John")).toEqual(["John"]);
    expect(splitAssignees("Ada Lovelace")).toEqual(["Ada Lovelace"]);
    expect(splitAssignees("John +  + Chetan")).toEqual(["John", "Chetan"]);
    expect(splitAssignees("   ")).toEqual([]);
  });
});

describe("initialsOf", () => {
  test("first + last initial for a full name, two chars for a single handle", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("John Ellison")).toBe("JE");
    expect(initialsOf("chetan")).toBe("CH");
    expect(initialsOf("Ada Byron King Lovelace")).toBe("AL");
  });

  test("never throws or renders empty on degenerate input", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("toneIndexOf", () => {
  test("is deterministic, so an assignee keeps the same colour across renders and sessions", () => {
    expect(toneIndexOf("John")).toBe(toneIndexOf("John"));
    expect(toneIndexOf("Chetan")).toBe(toneIndexOf("Chetan"));
  });

  test("stays inside the token palette for arbitrary input", () => {
    for (const name of ["John", "Chetan", "", "ZZZZZZZZZZZZZZZZ", "夜露死苦"]) {
      const index = toneIndexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(6);
    }
  });
});

describe("AssigneeAvatar", () => {
  test("renders one monogram per person and names them all for screen readers", () => {
    const html = renderToStaticMarkup(<AssigneeAvatar assignee="John + Chetan" />);
    expect(html).toContain("JO");
    expect(html).toContain("CH");
    expect(html).toContain("Assigned to John, Chetan");
  });

  test("overflows beyond `max` into a +n chip rather than growing without bound", () => {
    const html = renderToStaticMarkup(
      <AssigneeAvatar assignee="John + Chetan + Ada + Grace" max={2} />
    );
    expect(html).toContain("+2");
  });

  test("an empty assignee renders an explicit Unassigned placeholder, not a blank gap", () => {
    const html = renderToStaticMarkup(<AssigneeAvatar assignee="" />);
    expect(html).toContain("Unassigned");
  });
});
