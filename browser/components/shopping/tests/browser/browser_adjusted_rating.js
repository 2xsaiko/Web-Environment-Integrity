/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_adjusted_rating() {
  await BrowserTestUtils.withNewTab(
    {
      url: "chrome://browser/content/shopping/shopping.html",
      gBrowser,
    },
    async browser => {
      await SpecialPowers.spawn(browser, [], async function () {
        let rating = 2.5;
        let adjustedRating = content.document.createElement("adjusted-rating");
        adjustedRating.rating = rating;
        content.document.body.appendChild(adjustedRating);

        await adjustedRating.updateComplete;

        let mozFiveStar = adjustedRating.ratingEl;
        ok(mozFiveStar, "The moz-five-star element exists");

        is(mozFiveStar.rating, rating, `The moz-five-star rating is ${rating}`);
        is(
          adjustedRating.rating,
          rating,
          `The adjusted rating "rating" is ${rating}`
        );

        rating = 5;
        adjustedRating.rating = rating;

        await adjustedRating.updateComplete;

        is(
          mozFiveStar.rating,
          rating,
          `The moz-five-star rating is now ${rating}`
        );
        is(
          adjustedRating.rating,
          rating,
          `The adjusted rating "rating" is now ${rating}`
        );
      });
    }
  );
});
