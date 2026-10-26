// Issue #410 : les photos jointes depuis un iPhone (pellicule) arrivent en pleine
// résolution (~4032×3024, ~4 Mo). Elles ne sont ni redimensionnées ni compressées
// côté client, si bien que l'upload — et donc l'apparition de l'aperçu dans le
// champ de rédaction — devient très long sur mobile/PWA, et le rendu lourd.
//
// On redimensionne donc l'image dans le navigateur AVANT l'upload : on borne sa
// plus grande dimension et, pour les formats avec perte (JPEG/WebP), on ré-encode
// à une qualité raisonnable. La transparence du PNG est préservée (ré-encodage en
// PNG). Tout échec de décodage/encodage (format exotique type HEIC non décodable,
// canvas indisponible…) retombe silencieusement sur le fichier d'origine : la
// compression est une optimisation, elle ne doit jamais bloquer un envoi.

/** Plus grande dimension (px) tolérée pour une image jointe après redimensionnement. */
const MAX_DIMENSION = 1600;
/** Qualité de ré-encodage des formats avec perte (JPEG/WebP). */
const LOSSY_QUALITY = 0.82;

/**
 * Types raster que l'on sait décoder puis ré-encoder sans surprise. On exclut
 * volontairement le GIF (ré-encoder un canvas écraserait l'animation) et le SVG
 * (vectoriel, déjà léger) : ces formats sont renvoyés tels quels par `compressImage`.
 */
const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Dimensions cibles pour tenir dans une boîte `max × max` sans jamais agrandir,
 * en conservant le rapport d'aspect. Fonction pure, extraite pour être testable
 * indépendamment du canvas.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Dessine `bitmap` redimensionné dans un canvas puis l'encode en Blob. Utilise un
 * OffscreenCanvas quand il est disponible (pas de nœud DOM à insérer), sinon un
 * <canvas>. Renvoie null si le contexte 2D ou l'encodage n'est pas disponible.
 */
async function drawAndEncode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: string,
  quality: number
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality }).catch(() => null);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/**
 * Redimensionne et ré-encode une image trop grande avant son upload. Renvoie le
 * fichier d'origine inchangé si : ce n'est pas un format raster géré, l'image
 * tient déjà dans la boîte `MAX_DIMENSION`, le décodage/encodage échoue, ou le
 * résultat n'est pas plus léger que l'original. Le nom et le type MIME sont
 * conservés (ré-encodage dans le même format).
 */
export async function compressImage(file: File): Promise<File> {
  if (!COMPRESSIBLE.has(file.type)) return file;

  let bitmap: ImageBitmap;
  try {
    // `imageOrientation: "from-image"` applique l'orientation EXIF (les photos
    // iPhone sont fréquemment pivotées via ce champ) ; sans cela, le rendu serait
    // couché. L'option est ignorée là où elle n'est pas supportée.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }

  try {
    const target = fitWithin(bitmap.width, bitmap.height, MAX_DIMENSION);
    // Déjà assez petite : rien à gagner (et le ré-encodage JPEG serait une perte
    // de qualité gratuite). On garde l'original.
    if (target.width === bitmap.width && target.height === bitmap.height) {
      return file;
    }

    // PNG : sans perte, le paramètre de qualité est ignoré (transparence préservée).
    const quality = file.type === "image/png" ? 1 : LOSSY_QUALITY;
    const blob = await drawAndEncode(
      bitmap,
      target.width,
      target.height,
      file.type,
      quality
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
