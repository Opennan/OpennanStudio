import { fireEvent, render, screen } from "@testing-library/react";
import { Slider } from "./slider";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { renderWithTimeline } from "../test-utils/render-with-timeline";

describe("vendored ui", () => {
  it("slider commits only on release (slider.tsx:48-59)", () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();
    render(<Slider value={[10]} min={0} max={100} onValueChange={onValueChange} onValueCommit={onValueCommit} />);
    const input = screen.getByRole("slider");
    fireEvent.change(input, { target: { value: "40" } });
    expect(onValueChange).toHaveBeenCalledWith([40]);
    expect(onValueCommit).not.toHaveBeenCalled();
    fireEvent.mouseUp(input);
    expect(onValueCommit).toHaveBeenCalledTimes(1);
    // React drops the boolean `jsx` attribute, so also look for any <style> inside the slider.
    expect(document.querySelector("style[jsx], [data-slot='slider'] style")).toBeNull();
  });

  it("dialog close label comes from timeline messages and portals into the provider container", () => {
    renderWithTimeline(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
      { translate: (ns, key) => `${ns}.${key}` },
    );
    expect(screen.getByText("modals.close")).toBeInTheDocument();
    expect(screen.getByText("Title").closest(".opennan-studio-portal")).not.toBeNull();
  });
});
