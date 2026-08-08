/**
 * DTO for the Path B image/text AI extraction endpoint.
 * Either pastedText OR an image file (multipart) must be provided.
 * The image is received via multipart/form-data and handled separately in the controller.
 */
export class ExtractFromTextDto {
  /** Raw unstructured text pasted by the user (e.g. a WhatsApp channel post). */
  pastedText?: string;
}
