// Account channels: statuses and actions only. The key never crosses IPC in either direction, except a key the
// person pastes into "OpenNan API key (advanced)", which goes in and never comes back.
import { IPC } from "../../shared/ipc";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { AccountService } from "./account-service";

export function registerAccountIpc(ipc: IpcMainLike, { account }: { account: AccountService }): void {
    handle(ipc, IPC.accountStatus, () => account.status());
    handle(ipc, IPC.accountStart, async ({ signup }) => {
        await account.start(signup === true);
    });
    handle(ipc, IPC.accountReopen, () => {
        account.reopen();
    });
    handle(ipc, IPC.accountCancel, () => {
        account.cancel();
    });
    handle(ipc, IPC.accountSignOut, async () => {
        await account.signOut();
    });
    handle(ipc, IPC.accountSwitch, async () => {
        await account.switchAccount();
    });
    handle(ipc, IPC.accountRefresh, async () => {
        await account.refresh();
    });
    handle(ipc, IPC.accountOpenConsole, ({ page }) => {
        account.openConsole(page);
    });
    handle(ipc, IPC.accountConnectKey, async ({ key }) => {
        await account.connectKey(key);
    });
}
