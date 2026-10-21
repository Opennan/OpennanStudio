import { routeHref } from "../routing/routes";

export function ScreenMessage({ title, message }: { title: string; message: string }) {
    return (
        <main className="screen-message">
            <h1>{title}</h1>
            <p className="muted">{message}</p>
            <a className="button" href={routeHref({ name: "projects" })}>Back to projects</a>
        </main>
    );
}
