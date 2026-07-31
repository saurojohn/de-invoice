import { IsNumber, Min, Validate } from 'class-validator'

/**
 * Tier 123: DTO for PUT /api/v1/reminder/dunning-config.
 *
 * The 3 thresholds must be strictly increasing
 * (level1Days < level2Days < level3Days) — a
 * non-monotonic config would make the cron pick
 * a later level before an earlier one, which is
 * not what the Berater wants. We validate this
 * with a custom decorator (StrictlyIncreasingThresholds).
 *
 * The 3 fees must be >= 0. Negative fees make no
 * sense (a Mahnung that pays the customer to pay
 * the invoice is not legal German accounting).
 *
 * `class-validator` decorators are applied per
 * field; the threshold monotonicity is enforced
 * by a class-level @Validate in StrictlyIncreasingThresholds.
 */
import { registerDecorator, ValidationOptions } from 'class-validator'

export function StrictlyIncreasingThresholds(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'StrictlyIncreasingThresholds',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_: any, args: any) {
          const obj = args.object as DunningConfigDto
          return (
            obj.level1Days > 0 &&
            obj.level2Days > obj.level1Days &&
            obj.level3Days > obj.level2Days
          )
        },
        defaultMessage() {
          return 'level1Days < level2Days < level3Days (all > 0) is required'
        },
      },
    })
  }
}

export class DunningConfigDto {
  @IsNumber()
  @Min(1)
  @StrictlyIncreasingThresholds()
  level1Days!: number

  @IsNumber()
  @Min(2)
  level2Days!: number

  @IsNumber()
  @Min(3)
  level3Days!: number

  @IsNumber()
  @Min(0)
  level1Fee!: number

  @IsNumber()
  @Min(0)
  level2Fee!: number

  @IsNumber()
  @Min(0)
  level3Fee!: number
}
