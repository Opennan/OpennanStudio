// Starts the fake OpenNan server once for the run (the e2e build talks to it instead of api.opennan.com).
import { startE2eFakeOpenNan } from "./fixtures/fake-opennan";

export default async function globalSetup(): Promise<() => Promise<void>> {
    const fake = await startE2eFakeOpenNan();
    return () => fake.close();
}
