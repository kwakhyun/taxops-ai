import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableViewport } from "@/components/table-viewport";

describe("table viewport", () => {
  it("keeps server-rendered content keyboard accessible before overflow measurement", () => {
    const html = renderToStaticMarkup(
      <TableViewport label="세무 자료 목록">
        <table />
      </TableViewport>,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="세무 자료 목록"');
    expect(html).toContain('tabindex="0"');
  });
});
