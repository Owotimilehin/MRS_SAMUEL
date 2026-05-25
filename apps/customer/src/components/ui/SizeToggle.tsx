import { SIZES, type Size } from "../../data/menu.js";

/** Segmented control for choosing bottle size. Active pill uses the sunrise
 * gradient with white text. Used in hero Details card and every Full Menu card. */
export function SizeToggle({
  size,
  onChange,
}: {
  size: Size;
  onChange: (s: Size) => void;
}): JSX.Element {
  return (
    <div className="ms-size-toggle" role="radiogroup" aria-label="Bottle size">
      {SIZES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={size === s}
          className={size === s ? "is-active" : ""}
          onClick={() => onChange(s)}
        >
          {s}ml
        </button>
      ))}
    </div>
  );
}
