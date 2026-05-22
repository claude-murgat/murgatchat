import { describe, it, expect } from "vitest";
import { isUserDnd } from "../../src/socket.js";

// Local-time Date for a given hour/minute (isUserDnd reads getHours/getMinutes).
const at = (hh, mm = 0) => new Date(2026, 0, 1, hh, mm, 0);

describe("isUserDnd", () => {
  it("is false with no DnD settings", () => {
    expect(isUserDnd({}, at(12))).toBe(false);
  });

  it("honors a punctual window (dndUntil)", () => {
    const now = at(12);
    expect(isUserDnd({ dndUntil: new Date(now.getTime() + 60_000) }, now)).toBe(true);
    expect(isUserDnd({ dndUntil: new Date(now.getTime() - 60_000) }, now)).toBe(false);
  });

  it("ignores the schedule when disabled", () => {
    const user = { dndScheduleEnabled: false, dndStart: "08:00", dndEnd: "18:00" };
    expect(isUserDnd(user, at(12))).toBe(false);
  });

  it("applies a same-day daily range", () => {
    const user = { dndScheduleEnabled: true, dndStart: "08:00", dndEnd: "18:00" };
    expect(isUserDnd(user, at(12))).toBe(true); // inside
    expect(isUserDnd(user, at(8))).toBe(true); // inclusive start
    expect(isUserDnd(user, at(18))).toBe(false); // exclusive end
    expect(isUserDnd(user, at(7, 59))).toBe(false); // before
    expect(isUserDnd(user, at(20))).toBe(false); // after
  });

  it("applies a range that crosses midnight", () => {
    const user = { dndScheduleEnabled: true, dndStart: "22:00", dndEnd: "07:00" };
    expect(isUserDnd(user, at(23))).toBe(true); // late evening
    expect(isUserDnd(user, at(3))).toBe(true); // early morning
    expect(isUserDnd(user, at(22))).toBe(true); // inclusive start
    expect(isUserDnd(user, at(7))).toBe(false); // exclusive end
    expect(isUserDnd(user, at(12))).toBe(false); // midday
  });

  it("treats start == end as no range", () => {
    const user = { dndScheduleEnabled: true, dndStart: "09:00", dndEnd: "09:00" };
    expect(isUserDnd(user, at(9))).toBe(false);
    expect(isUserDnd(user, at(15))).toBe(false);
  });
});
