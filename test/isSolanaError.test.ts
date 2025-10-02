import { isSolanaError, SolanaErrorLike, SVM_SLOT_SKIPPED } from "../src/arch/svm/provider";
import { expect } from "./utils";

describe("isSolanaError type guard", () => {
  it("should detect a properly structured SolanaError object", () => {
    const error = {
      name: "SolanaError",
      context: {
        __code: SVM_SLOT_SKIPPED,
        __serverMessage: "Slot was skipped",
      },
    };

    expect(isSolanaError(error)).to.be.true;
  });

  it("should detect a flattened/serialized SolanaError with null prototype", () => {
    // Create a proper SolanaError-like object
    const error = {
      name: "SolanaError",
      context: {
        __code: SVM_SLOT_SKIPPED,
        __serverMessage: "Slot was skipped",
      },
      cause: undefined,
    };

    // Simulate serialization/deserialization which creates null prototype objects
    const serialized = JSON.stringify(error);
    const flattened = JSON.parse(serialized);

    // Verify the flattened error has lost its prototype chain
    expect(Object.getPrototypeOf(flattened)).to.not.equal(Error.prototype);

    // The type guard should still detect it as a SolanaError
    expect(isSolanaError(flattened)).to.be.true;
  });

  it("should provide proper type inference for detected errors", () => {
    const error = {
      name: "SolanaError",
      context: {
        __code: -32009,
        __serverMessage: "Test error",
        statusCode: 429,
      },
    };

    if (isSolanaError(error)) {
      // These should all be accessible without type assertions
      const code: number = error.context.__code;
      const message: string | undefined = error.context.__serverMessage;
      const status: number | undefined = error.context.statusCode;

      expect(code).to.equal(-32009);
      expect(message).to.equal("Test error");
      expect(status).to.equal(429);
    } else {
      throw new Error("Error should have been detected as SolanaError");
    }
  });

  it("should reject objects missing the required name field", () => {
    const error = {
      context: {
        __code: SVM_SLOT_SKIPPED,
      },
    };

    expect(isSolanaError(error)).to.be.false;
  });

  it("should reject objects missing the required __code field", () => {
    const error = {
      name: "SolanaError",
      context: {},
    };

    expect(isSolanaError(error)).to.be.false;
  });

  it("should reject objects with incorrect field types", () => {
    const error = {
      name: "SolanaError",
      context: {
        __code: "not a number", // Should be number
      },
    };

    expect(isSolanaError(error)).to.be.false;
  });

  it("should reject non-SolanaError objects", () => {
    const regularError = new Error("Regular error");
    expect(isSolanaError(regularError)).to.be.false;

    const randomObject = { foo: "bar" };
    expect(isSolanaError(randomObject)).to.be.false;

    expect(isSolanaError(null)).to.be.false;
    expect(isSolanaError(undefined)).to.be.false;
    expect(isSolanaError("string")).to.be.false;
    expect(isSolanaError(123)).to.be.false;
  });

  it("should allow additional properties in context object", () => {
    const error = {
      name: "SolanaError",
      context: {
        __code: SVM_SLOT_SKIPPED,
        __serverMessage: "Slot was skipped",
        statusCode: 500,
        customField: "custom value",
        anotherField: { nested: "object" },
      },
    };

    expect(isSolanaError(error)).to.be.true;
  });

  it("should handle errors with cause property", () => {
    const innerError = new Error("Inner error");
    const error = {
      name: "SolanaError",
      context: {
        __code: SVM_SLOT_SKIPPED,
      },
      cause: innerError,
    };

    expect(isSolanaError(error)).to.be.true;

    if (isSolanaError(error)) {
      expect(error.cause).to.equal(innerError);
    }
  });

  it("should detect errors that have been serialized and deserialized multiple times", () => {
    const originalError: SolanaErrorLike = {
      name: "SolanaError",
      context: {
        __code: -32009,
        __serverMessage: "Block not available",
        statusCode: 500,
      },
    };

    // Serialize and deserialize multiple times
    let error: unknown = originalError;
    for (let i = 0; i < 3; i++) {
      error = JSON.parse(JSON.stringify(error));
    }

    // Should still be detected as a SolanaError
    expect(isSolanaError(error)).to.be.true;

    if (isSolanaError(error)) {
      expect(error.context.__code).to.equal(-32009);
      expect(error.context.__serverMessage).to.equal("Block not available");
      expect(error.context.statusCode).to.equal(500);
    }
  });
});
