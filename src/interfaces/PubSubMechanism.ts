export interface PubSubMechanismInterface {
  /**
   * Subscribes to a topic.
   * @param topic The topic to subscribe to.
   * @param callback The callback to call when a message is received.
   */
  sub<T>(topic: string, callback: (message: T) => unknown): Promise<void>;

  /**
   * Publishes a message to the network.
   * @param topic The topic to publish to.
   * @param message The message to publish.
   */
  pub<T>(topic: string, message: T): Promise<void>;
}
