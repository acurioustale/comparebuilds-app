import { iconUrl, onIconError } from "../lib/iconUrl";

/**
 * The standard talent-icon <img>, shared by every node renderer (TalentNode and
 * HeatmapTree's HeatmapNode) so the icon element's loading attributes can't drift
 * between the interactive/import trees and the heatmap. Rendered as a block image
 * sized `size` px square; the caller's wrapper owns the border, radius and clip.
 *
 * @param {object} props
 * @param {string} props.icon Icon slug passed to iconUrl
 * @param {number} props.size Width/height in px
 * @returns {import("react").JSX.Element}
 */
export default function NodeIcon({ icon, size }) {
  return (
    <img
      src={iconUrl(icon)}
      onError={onIconError}
      width={size}
      height={size}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      style={{ display: "block" }}
    />
  );
}
