import type { AccountInfo } from "@opennan/provider-opennan";

/** The account's photo, or its initial on a tinted circle. */
export function Avatar({ account, size }: { account: Pick<AccountInfo, "displayName" | "email" | "photoUrl"> | null; size: number }) {
    const initial = (account?.displayName || account?.email || "?").trim().charAt(0).toUpperCase() || "?";
    return (
        <span className="account-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
            {account?.photoUrl ? <img src={account.photoUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" /> : initial}
        </span>
    );
}
