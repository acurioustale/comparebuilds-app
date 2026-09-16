/**
 * Touch-identity helpers shared by the two gestures the talent tree runs on a
 * node: the tap that spends a point (useTapGesture) and the long-press that
 * peeks its tooltip (Tooltip's `touch: "hold"` mode).
 *
 * Both had the same class of defect — handlers that could not say WHICH finger
 * they were looking at, so any finger on the screen could complete or cancel a
 * gesture another finger had started. Keeping the rule in one place is what
 * stops the two from drifting apart again.
 *
 * Pure: these take the plain touch-list-shaped objects off an event and use no
 * DOM API of their own.
 */

/**
 * Finds the touch with `id` in one of an event's touch lists. Identifiers are
 * per-finger and stable for the life of a touch, which is what lets a handler
 * tell its own finger from any other.
 *
 * @param {ArrayLike<{identifier?: number}>|undefined} list
 * @param {number|undefined|null} id
 * @returns {{identifier?: number}|undefined} The matching touch, if any.
 */
export const touchById = (list, id) => {
  if (!list || id == null) return undefined;
  for (const t of list) if (t.identifier === id) return t;
  return undefined;
};

/**
 * Whether `event` is the lift (touchend/touchcancel) of the finger that owns
 * `gesture`. `changedTouches` holds exactly the fingers the event lifted, so a
 * gesture whose own finger is absent from it is still in progress and must not
 * be completed or cancelled.
 *
 * A gesture with no recorded identifier — a synthetic event, or a test double
 * that carries no touch lists — falls back to "yes", preserving the
 * single-touch behaviour these handlers had before identity was tracked.
 *
 * @param {{changedTouches?: ArrayLike<{identifier?: number}>}|undefined|null} event
 * @param {{id?: number}|null|undefined} gesture State recorded at touchstart.
 * @returns {boolean}
 */
export const ownTouchLifted = (event, gesture) => {
  if (!gesture) return false;
  if (gesture.id == null || !event?.changedTouches) return true;
  return touchById(event.changedTouches, gesture.id) !== undefined;
};

/**
 * The touches of `event` that belong to the element the handler is attached to.
 *
 * `event.touches` counts every touch on the DOCUMENT, so using it to decide
 * "is more than one finger on this node" makes a finger resting anywhere on
 * screen — the thumb holding the phone — look like a second finger here.
 * `targetTouches` is scoped to the element, and a real touchstart always lists
 * the started finger in it; an empty list means a synthetic event that did not
 * populate one, so fall back rather than drop the gesture.
 *
 * @param {{targetTouches?: ArrayLike<unknown>, touches: ArrayLike<unknown>}} event
 * @returns {ArrayLike<unknown>}
 */
export const ownTouches = (event) =>
  event.targetTouches?.length ? event.targetTouches : event.touches;
