import type { User } from "../types.ts";

// Avatar accepte aussi bien le `publicUser` complet que la référence réduite
// embarquée dans un message (`Message["author"]`, dont les champs sont
// optionnels) : on ne type donc que les trois propriétés réellement lues.
type AvatarUser = Partial<Pick<User, "displayName" | "username" | "avatarColor">>;

interface AvatarProps {
  user?: AvatarUser | null;
  size?: number;
}

export default function Avatar({ user, size = 36 }: AvatarProps) {
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
