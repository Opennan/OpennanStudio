import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithTimeline } from "../test-utils/render-with-timeline";
import { TrackVolumeControl } from "./track-volume-control";
import { TimelineErrorBoundary } from "./timeline-error-boundary";
import { AddTrackButton } from "./add-track-button";

function Boom(): never {
  throw new Error("kaput");
}

describe("small parts", () => {
  it("track volume commits once on release and portals into the provider container", () => {
    const onSetVolume = vi.fn();
    renderWithTimeline(
      <TrackVolumeControl muted={false} volume={0.5} buttonClassName="" activeButtonClassName="" onToggleMute={vi.fn()} onSetVolume={onSetVolume} />,
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: "mute" }));
    const slider = screen.getByRole("slider");
    expect(slider.closest(".opennan-studio-portal")).not.toBeNull();
    fireEvent.change(slider, { target: { value: "80" } });
    expect(onSetVolume).not.toHaveBeenCalled();
    fireEvent.mouseUp(slider);
    expect(onSetVolume).toHaveBeenCalledTimes(1);
  });

  it("add-track menu labels come from addTrack messages", () => {
    const onAddTrack = vi.fn();
    renderWithTimeline(<AddTrackButton onAddTrack={onAddTrack} />);
    fireEvent.click(screen.getByRole("button", { name: "title" }));
    expect(screen.getByRole("menuitem", { name: "effectTrack" }).closest(".opennan-studio-portal")).not.toBeNull();
  });

  it("error boundary shows localized text, reports, and resets", () => {
    const onError = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function Maybe() {
      return shouldThrow ? <Boom /> : <span>ok</span>;
    }
    renderWithTimeline(<TimelineErrorBoundary onError={onError}><Maybe /></TimelineErrorBoundary>);
    expect(screen.getByText("crashed")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
    shouldThrow = false;
    act(() => screen.getByRole("button", { name: "reload" }).click());
    expect(screen.getByText("ok")).toBeInTheDocument();
    spy.mockRestore();
  });
});
