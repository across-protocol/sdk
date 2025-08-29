export interface PubSubMechanismInterface {
  /**
   * Subscribes to a topic.
   * @param topic The topic to subscribe to.
   * @param callback The callback to call when a message is received.
   */
  sub(topic: string, callback: (message: string, channel: string) => unknown): Promise<void>;

  /**
   * Publishes a message to the network.
   * @param topic The topic to publish to.
   * @param message The message to publish.
   * @returns The number of subscribers to the topic.
   */
  pub(topic: string, message: string): Promise<number>;
}
