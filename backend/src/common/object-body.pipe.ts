import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common'

/**
 * Tier 846 — the body of a request that is read into a DTO is a JSON object.
 *
 * The ValidationPipe validates an object's properties; a list (`[]`) has
 * none, passed, and the service handed it to Prisma: HTTP 500 on
 * PUT /companies/:id, /customers/:id and /products/:id (measured). Routes
 * whose body is declared as a list or as a plain value are not touched.
 */
const PLAIN: unknown[] = [Object, Array, String, Number, Boolean]

@Injectable()
export class ObjectBodyPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== 'body' || metadata.data !== undefined) return value
    if (!metadata.metatype || PLAIN.includes(metadata.metatype)) return value
    if (value === undefined || value === null) return value // an empty body: the DTO's own checks say what is missing
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Der Inhalt der Anfrage muss ein JSON-Objekt sein.')
    }
    return value
  }
}
