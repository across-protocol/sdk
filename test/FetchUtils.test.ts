import { fetchWithTimeout, HttpError, isHttpError } from "../src/utils";
import { expect, sinon } from "./utils";

describe("FetchUtils", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("throws HttpError with status on non-ok JSON responses", async () => {
    sinon.stub(globalThis, "fetch").resolves(
      new Response(JSON.stringify({ error: "Proof request abc not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      })
    );

    try {
      await fetchWithTimeout("https://example.com");
      expect.fail("Expected fetchWithTimeout to throw");
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect(error).to.be.instanceOf(HttpError);
      expect(isHttpError(error)).to.be.true;

      if (!isHttpError(error)) {
        throw error;
      }

      expect(error.status).to.equal(404);
      expect(error.message).to.equal("Proof request abc not found");
    }
  });

  it("falls back to an HTTP status message when the error body is not JSON", async () => {
    sinon
      .stub(globalThis, "fetch")
      .resolves(new Response("not json", { status: 500, statusText: "Internal Server Error" }));

    try {
      await fetchWithTimeout("https://example.com");
      expect.fail("Expected fetchWithTimeout to throw");
    } catch (error) {
      expect(error).to.be.instanceOf(HttpError);
      expect(isHttpError(error)).to.be.true;

      if (!isHttpError(error)) {
        throw error;
      }

      expect(error.status).to.equal(500);
      expect(error.message).to.equal("HTTP 500: Internal Server Error");
    }
  });
});
