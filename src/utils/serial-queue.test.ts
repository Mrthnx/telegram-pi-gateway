import { describe, expect, test } from "bun:test";
import { SerialQueue } from "./serial-queue";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SerialQueue", () => {
  test("runs a single task", async () => {
    const queue = new SerialQueue();

    const result = await queue.run("a", async () => "listo");

    expect(result).toBe("listo");
  });

  test("runs the tasks of the same key one after the other", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const first = queue.run("a", async () => {
      order.push("a:start");
      await tick(30);
      order.push("a:end");
      return 1;
    });
    const second = queue.run("a", async () => {
      order.push("b:start");
      order.push("b:end");
      return 2;
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("runs the tasks of different keys at the same time", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const first = queue.run("a", async () => {
      order.push("a:start");
      await tick(30);
      order.push("a:end");
    });
    const second = queue.run("b", async () => {
      order.push("b:start");
      await tick(1);
      order.push("b:end");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  test("tells the caller when the task has to wait", async () => {
    const queue = new SerialQueue();
    const queued: string[] = [];

    const first = queue.run("a", async () => {
      await tick(20);
    });
    const second = queue.run("a", async () => undefined, () => queued.push("a"));
    const third = queue.run("a", async () => undefined, () => queued.push("b"));
    const other = queue.run("z", async () => undefined, () => queued.push("z"));

    await Promise.all([first, second, third, other]);

    expect(queued).toEqual(["a", "b"]);
  });

  test("keeps running after a task fails", async () => {
    const queue = new SerialQueue();

    const failing = queue.run("a", async () => {
      throw new Error("boom");
    });
    const following = queue.run("a", async () => "despues");

    await expect(failing).rejects.toThrow("boom");
    expect(await following).toBe("despues");
  });

  test("forgets the key once the queue drains", async () => {
    const queue = new SerialQueue();

    await queue.run("a", async () => undefined);
    await queue.run("a", async () => undefined);

    expect(queue.isBusy("a")).toBe(false);
  });
});
