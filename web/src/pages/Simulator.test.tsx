import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { Simulator } = await import("./Simulator.js");

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(cleanup);

test("simulator is local-only, renders the flow, and has no backend flush", async () => {
  const { container } = render(<Simulator />);

  expect(screen.getByText(/local only/)).toBeTruthy();
  expect(screen.queryByText("Flush")).toBeNull();

  fireEvent.click(screen.getByText("Send"));

  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());
  expect(screen.getByText("System flow")).toBeTruthy();
  expect(container.querySelectorAll(".flow-stage").length).toBeGreaterThan(0);
  expect(screen.getAllByText("AI Brain").length).toBeGreaterThan(0);
});

test("clicking a stage opens its inspector detail", async () => {
  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  fireEvent.click(screen.getByText("Protect privacy"));
  await waitFor(() => expect(screen.getByText(/Redacted preview/)).toBeTruthy());
});

test("insight tab reveals collapsible analysis cards", async () => {
  render(<Simulator />);

  // Stage tab is shown first, so the insight cards are not in the DOM yet.
  expect(screen.queryByText(/What it would remember/)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /What Nocheh noticed/ }));
  await waitFor(() => expect(screen.getByText(/What it would remember/)).toBeTruthy());
  expect(screen.getByText(/Ideas it would suggest/)).toBeTruthy();
  expect(screen.getByText(/Safety checks/)).toBeTruthy();
});

test("knowledge tab renders the graph", async () => {
  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  fireEvent.click(screen.getByRole("tab", { name: /Knowledge graph/ }));
  await waitFor(() => expect(document.querySelector(".knowledge-graph")).toBeTruthy());
});

test("clear empties only the local simulator transcript", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  fireEvent.click(screen.getByText("Clear"));
  await waitFor(() => expect(screen.getByText(/No messages yet/)).toBeTruthy());
  expect(screen.getByText(/No persisted conversations were changed/)).toBeTruthy();
});
