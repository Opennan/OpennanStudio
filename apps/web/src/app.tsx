import { AccountProvider } from "./account/account-context";
import { EditorRoute } from "./editor/editor-screen";
import { StudioRuntimeProvider } from "./platform/runtime-context";
import type { StudioRuntime } from "./platform/runtime-types";
import { ProjectListScreen } from "./projects/project-list-screen";
import type { Route } from "./routing/routes";
import { useRoute } from "./routing/use-route";
import { ProviderSettingsScreen } from "./settings/provider-settings-screen";
import { ScreenMessage } from "./ui/screen-message";
import { useStudioTheme } from "./ui/theme";
import "./ui/text-fonts";

/** The editor shell over a host-supplied runtime (web: studio-runtime.ts; desktop: apps/desktop). */
export function App({ runtime }: { runtime: StudioRuntime }) {
    useStudioTheme();
    const route = useRoute();
    return (
        <StudioRuntimeProvider runtime={runtime}>
            <AccountProvider account={runtime.account} providers={runtime.providers}>
                <Screen route={route} />
            </AccountProvider>
        </StudioRuntimeProvider>
    );
}

function Screen({ route }: { route: Route }) {
    switch (route.name) {
        case "projects":
            return <ProjectListScreen />;
        case "editor":
            return <EditorRoute key={route.projectId} projectId={route.projectId} />;
        case "providers":
            return <ProviderSettingsScreen />;
        default:
            return <ScreenMessage title="Page not found" message="This link does not point to a project or a settings page." />;
    }
}
