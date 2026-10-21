import { useEffect, useState } from "react";
import { parseRoute, type Route } from "./routes";

export function useRoute(): Route {
    const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
    useEffect(() => {
        const onChange = () => setRoute(parseRoute(window.location.hash));
        window.addEventListener("hashchange", onChange);
        return () => window.removeEventListener("hashchange", onChange);
    }, []);
    return route;
}
