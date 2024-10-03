import { queue } from "async";
import { assertPromisePasses, expect } from "./utils";
import { delay } from "../src/utils";

interface TempTask {
  resolve: (result: unknown) => void;
}

describe("providers", () => {
  it("should correctly run the async/queue library", async () => {
    // Fix the concurrency to 2 & the totalTasks to 100
    const totalTasks = 100;
    const concurrency = 5;
    // Use this counter to track the number of tasks that have been resolved.
    let amnt = 0;
    // This function builds a list of temporary tasks that resolve the amnt counter.
    const buildListOfTempTasks = (numTasks: number) =>
      Array.from({ length: numTasks }, () => ({ resolve: () => amnt++ }));
    // Create a queue with a concurrency of 2 that should resolve the tasks provided
    // because a callback is provided.
    const testQueue = queue(({ resolve }: TempTask, callback) => {
      resolve("success");
      callback();
    }, concurrency);
    // Build a list of temporary tasks and submit them to the queue with
    // a callback provided
    let tasks = buildListOfTempTasks(totalTasks);
    // Ensure that the queue without a callback does not resolve the tasks.
    tasks.forEach((t) => testQueue.push(t));
    // Ensure that the queue can (A) empty itself and (B) resolve all tasks.
    await assertPromisePasses(testQueue.drain());
    // Finally check that the amount of resolved tasks is equal to the total amount of tasks.
    expect(amnt).to.equal(totalTasks);
    expect(testQueue.length()).to.equal(0);

    amnt = 0;
    tasks = buildListOfTempTasks(totalTasks);
    const testQueueWithoutCallback = queue(({ resolve }: TempTask) => {
      resolve("success");
    }, concurrency);
    // Submit the existing tasks to the queue without a callback.
    tasks.forEach((t) => testQueueWithoutCallback.push(t));
    // Wait for several seconds to ensure that the queue has time to resolve the tasks.
    await delay(5); // 5 seconds
    expect(testQueueWithoutCallback.started).to.be.true; // The queue should have started.
    expect(testQueueWithoutCallback.idle()).to.be.false; // The queue should not be idle.
    expect(testQueueWithoutCallback.length()).to.equal(totalTasks - concurrency); // The queue should have failed to resolve all tasks.
    expect(amnt).to.equal(concurrency); // The amount of resolved tasks should be equal to the concurrency because no task truly finished.
  });
});
