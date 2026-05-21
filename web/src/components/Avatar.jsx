export default function Avatar({ user, size = 36 }) {
  const initials = (user?.displayName || user?.username || "?")
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      className="rounded-md grid place-items-center font-semibold text-white shrink-0"
      style={{
        width: size,
        height: size,
        background: user?.avatarColor || "#4A154B",
        fontSize: size * 0.42,
      }}
    >
      {initials}
    </div>
  );
}
