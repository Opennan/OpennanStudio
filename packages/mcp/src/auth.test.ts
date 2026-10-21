import { bearerMatches, createSessionToken, isAllowedHost, isAllowedOrigin, isValidToken } from "./auth";

describe("auth", () => {
    it("creates long random tokens", () => {
        const a = createSessionToken();
        expect(isValidToken(a)).toBe(true);
        expect(a).not.toBe(createSessionToken());
        expect(isValidToken("short")).toBe(false);
    });

    it("accepts only the exact bearer token", () => {
        const token = createSessionToken();
        expect(bearerMatches(`Bearer ${token}`, token)).toBe(true);
        expect(bearerMatches(`bearer ${token}`, token)).toBe(true);
        expect(bearerMatches(`Bearer ${token}x`, token)).toBe(false);
        expect(bearerMatches(token, token)).toBe(false);
        expect(bearerMatches(undefined, token)).toBe(false);
    });

    it("limits Host and Origin to this loopback port", () => {
        expect(isAllowedHost("127.0.0.1:4319", 4319)).toBe(true);
        expect(isAllowedHost("localhost:4319", 4319)).toBe(true);
        expect(isAllowedHost("evil.test:4319", 4319)).toBe(false);
        expect(isAllowedHost(undefined, 4319)).toBe(false);
        expect(isAllowedOrigin(undefined, 4319)).toBe(true);
        expect(isAllowedOrigin("http://localhost:4319", 4319)).toBe(true);
        expect(isAllowedOrigin("https://evil.test", 4319)).toBe(false);
    });
});
