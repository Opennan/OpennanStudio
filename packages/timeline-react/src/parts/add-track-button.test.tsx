// Behavior coverage for the timeline add-track menu.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddTrackButton } from "./add-track-button";
import { renderWithTimeline } from "../test-utils/render-with-timeline";

afterEach(() => {
  cleanup();
});

describe("AddTrackButton", () => {
  it("lets users add an effect track from the track menu", () => {
    const onAddTrack = vi.fn();

    renderWithTimeline(<AddTrackButton onAddTrack={onAddTrack} />);

    fireEvent.click(screen.getByRole("button", { name: "title" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "effectTrack" }));

    expect(onAddTrack).toHaveBeenCalledWith("effect");
  });

  it("lets users add a graphics (remotion) track from the track menu", () => {
    const onAddTrack = vi.fn();

    renderWithTimeline(<AddTrackButton onAddTrack={onAddTrack} />);

    fireEvent.click(screen.getByRole("button", { name: "title" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "graphicsTrack" }));

    expect(onAddTrack).toHaveBeenCalledWith("remotion");
  });
});
